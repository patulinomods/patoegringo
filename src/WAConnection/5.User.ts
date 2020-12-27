import {WAConnection as Base} from './4.Events'
import { Presence, WABroadcastListInfo, WAProfilePictureChange, WALoadChatOptions, WAChatIndex, BlocklistUpdate } from './Constants'
import {
    WAMessage,
    WANode,
    WAMetric,
    WAFlag,
} from '../WAConnection/Constants'
import { generateProfilePicture, whatsappID } from './Utils'
import { Mutex } from './Mutex'
import { URL } from 'url'

// All user related functions -- get profile picture, set status etc.

export class WAConnection extends Base {
    /** 
     * Query whether a given number is registered on WhatsApp
     * @param str phone number/jid you want to check for
     * @returns undefined if the number doesn't exists, otherwise the correctly formatted jid
     */
    isOnWhatsApp = async (str: string) => {
        if (this.state !== 'open') {
            return this.isOnWhatsAppNoConn(str)
        }
        const { status, jid } = await this.query({json: ['query', 'exist', str], requiresPhoneConnection: false})
        if (status === 200) return { exists: true, jid: whatsappID(jid) }
    }
    /** 
     * Query whether a given number is registered on WhatsApp, without needing to open a WS connection
     * @param str phone number/jid you want to check for
     * @returns undefined if the number doesn't exists, otherwise the correctly formatted jid
     */
    isOnWhatsAppNoConn = async (str: string) => {
        let phone = str.split('@')[0]
        const url = `https://wa.me/${phone}`
        const response = await this.fetchRequest(url, 'GET', undefined, undefined, undefined, 'manual')
        const loc = response.headers.get('Location')
        if (!loc) {
            this.logger.warn({ url, status: response.status }, 'did not get location from request')
            return
        }
        const locUrl = new URL('', loc)
        if (!locUrl.pathname.endsWith('send/')) {
            return
        }
        phone = locUrl.searchParams.get('phone')
        return { exists: true, jid: `${phone}@s.whatsapp.net` } 
    }
    /**
     * Tell someone about your presence -- online, typing, offline etc.
     * @param jid the ID of the person/group who you are updating
     * @param type your presence
     */
    updatePresence = (jid: string | null, type: Presence) => this.sendBinary(
        [   'action', 
            {epoch: this.msgCount.toString(), type: 'set'},
            [ ['presence', { type: type, to: jid }, null] ]
        ],
        [WAMetric.presence, WAFlag[type] ], // weird stuff WA does
        undefined,
        true
    )
    /** Request an update on the presence of a user */
    requestPresenceUpdate = async (jid: string) => this.query({ json: ['action', 'presence', 'subscribe', jid] })
    /** Query the status of the person (see groupMetadata() for groups) */
    async getStatus (jid?: string) {
        const status: { status: string } = await this.query({ json: ['query', 'Status', jid || this.user.jid], requiresPhoneConnection: false })
        return status
    }
    async setStatus (status: string) {
        const response = await this.setQuery (
            [
                [
                    'status',
                    null,
                    Buffer.from (status, 'utf-8')
                ]
            ]
        ) 
        this.emit ('user-status-update', { jid: this.user.jid, status })
        return response
    }
    /** Get your contacts */
    async getContacts() {
        const json = ['query', { epoch: this.msgCount.toString(), type: 'contacts' }, null]
        const response = await this.query({ json, binaryTags: [WAMetric.queryContact, WAFlag.ignore], expect200: true, requiresPhoneConnection: true }) // this has to be an encrypted query
        return response
    }
    /** Get the stories of your contacts */
    async getStories() {
        const json = ['query', { epoch: this.msgCount.toString(), type: 'status' }, null]
        const response = await this.query({json, binaryTags: [WAMetric.queryStatus, WAFlag.ignore], expect200: true, requiresPhoneConnection: true }) as WANode
        if (Array.isArray(response[2])) {
            return response[2].map (row => (
                { 
                    unread: row[1]?.unread, 
                    count: row[1]?.count, 
                    messages: Array.isArray(row[2]) ? row[2].map (m => m[2]) : []
                } as {unread: number, count: number, messages: WAMessage[]}
            ))
        }
        return []
    }
    /** Fetch your chats */
    async getChats() {
        const json = ['query', { epoch: this.msgCount.toString(), type: 'chat' }, null]
        return this.query({ json, binaryTags: [5, WAFlag.ignore], expect200: true }) // this has to be an encrypted query
    }
    /** Query broadcast list info */
    async getBroadcastListInfo(jid: string) { 
        return this.query({
            json: ['query', 'contact', jid], 
            expect200: true, 
            requiresPhoneConnection: true
        }) as Promise<WABroadcastListInfo> 
    }
    /**
     * Load chats in a paginated manner + gets the profile picture
     * @param before chats before the given cursor
     * @param count number of results to return
     * @param searchString optionally search for users
     * @returns the chats & the cursor to fetch the next page
     */
    async loadChats (count: number, before: string | null, options: WALoadChatOptions = {}) {
        const searchString = options.searchString?.toLowerCase()
        const chats = this.chats.paginated (before, count, options && (chat => (
            (typeof options?.custom !== 'function' || options?.custom(chat)) &&
            (typeof searchString === 'undefined' || chat.name?.toLowerCase().includes (searchString) || chat.jid?.includes(searchString))
        )))
        let loadPP = this.loadProfilePicturesForChatsAutomatically
        if (typeof options.loadProfilePicture !== 'undefined') loadPP = options.loadProfilePicture
        if (loadPP) {
            await Promise.all (
                chats.map (async chat => (
                    typeof chat.imgUrl === 'undefined' && await this.setProfilePicture (chat)
                ))
            )
        }
        const cursor = (chats[chats.length-1] && chats.length >= count) && this.chatOrderingKey.key (chats[chats.length-1])
        return { chats, cursor }
    }
    /**
     * Update the profile picture
     * @param jid 
     * @param img 
     */
    @Mutex (jid => jid)
    async updateProfilePicture (jid: string, img: Buffer) {
        jid = whatsappID (jid)
        const data = await generateProfilePicture (img)
        const tag = this.generateMessageTag ()
        const query: WANode = [
            'picture', 
            { jid: jid, id: tag, type: 'set' }, 
            [
                ['image', null, data.img],
                ['preview', null, data.preview]
            ]
        ]
        const response = await (this.setQuery ([query], [WAMetric.picture, 136], tag) as Promise<WAProfilePictureChange>)
        if (jid === this.user.jid) this.user.imgUrl = response.eurl
        else if (this.chats.get(jid)) {
            this.chats.get(jid).imgUrl = response.eurl
            this.emit ('chat-update', { jid, imgUrl: response.eurl })
        }
        return response
    }
    /**
     * Add or remove user from blocklist
     * @param jid the ID of the person who you are blocking/unblocking
     * @param type type of operation
     */
    @Mutex (jid => jid)
    async blockUser (jid: string, type: 'add' | 'remove' = 'add') {
        jid.replace('@s.whatsapp.net', '@c.us')

        const tag = this.generateMessageTag()
        const json: WANode = [
            'block',
            {
                type: type,
            },
            [
                ['user', { jid }, null]
            ],
        ]
        const result = await this.setQuery ([json], [WAMetric.block, WAFlag.ignore], tag)

        if (result.status === 200) {
            if (type === 'add') {
                this.blocklist.push(jid)
            } else {
                const index = this.blocklist.indexOf(jid);
                if (index !== -1) {
                    this.blocklist.splice(index, 1);
                }
            }

            // Blocklist update event
            const update: BlocklistUpdate = { added: [], removed: [] }
            let key = type === 'add' ? 'added' : 'removed'
            update[key] = [ jid ]
            this.emit('blocklist-update', update)
        }

        return result
    }
}
