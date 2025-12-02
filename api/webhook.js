const Redis = require('ioredis');

// ==========================================
//  CONFIGURATION
// ==========================================
const CONFIG = {
    TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    REDIS_URL: process.env.REDIS_URL,
    MESSAGE_TTL: 86400,
    REPLY_WINDOW: 300
};

if (!CONFIG.TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is missing");

// Initialize Redis
const redis = new Redis(CONFIG.REDIS_URL, {
    retryStrategy: (times) => Math.min(times * 50, 2000)
});

redis.on('error', (err) => console.error('[REDIS] Error:', err));
redis.on('connect', () => console.log('[REDIS] Connected'));

// ==========================================
//  TELEGRAM API HELPER (Native Fetch)
// ==========================================
const Telegram = {
    call: async (method, body) => {
        const url = `https://api.telegram.org/bot${CONFIG.TOKEN}/${method}`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await response.json();
            if (!data.ok) {
                console.error(`[TELEGRAM] Error calling ${method}:`, data.description);
            }
            return data;
        } catch (e) {
            console.error(`[TELEGRAM] Network Error calling ${method}:`, e);
            return null;
        }
    },
    sendMessage: async (chatId, text, options = {}) => {
        return await Telegram.call('sendMessage', {
            chat_id: chatId,
            text: text,
            parse_mode: 'Markdown',
            ...options
        });
    },
    answerCallbackQuery: async (callbackQueryId, text = null) => {
        return await Telegram.call('answerCallbackQuery', {
            callback_query_id: callbackQueryId,
            text: text
        });
    },
    editMessageReplyMarkup: async (chatId, messageId, replyMarkup) => {
        return await Telegram.call('editMessageReplyMarkup', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: replyMarkup
        });
    }
};

// ==========================================
//  UI & TEXT ASSETS
// ==========================================
const UI = {
    welcome: (name) => `
👋 **Hello, ${name}!**

I am your personal **Game Assistant**. 🛡️
I can send you real-time notifications about:
• ⚔️ Battles
• 📩 Private Messages
• 📜 Guild Events

👇 **Connect your account to get started!**
`,
    help: `
📚 **Bot Commands Help**

/start - Main Menu
/link <token> - Connect Account
/disconnect - Disconnect Account
/status - Connection Status
/reply <Msg> - Reply to last PM (5m limit)
/guild <Msg> - Reply to last Guild Msg (5m limit)
`,
    linked: (userId, serverId) => `
🎉 **Connection Successful!**

👤 **User ID:** \`${userId}\`
🌍 **Server:** ${serverId || 'Unknown'}

You will now receive notifications here. 🚀
`,
    notLinked: `
⚠️ **Account Not Linked**

Please go to the game settings, click **"Connect Telegram"**, and use the token provided.
`,
    status: (userId) => `
📡 **System Status: ONLINE**

✅ **Connected**
👤 **User ID:** \`${userId}\`

All systems operational.
`,
    noReplyContext: `
⚠️ **No active conversation.**

You can only use /reply or /guild within **5 minutes** of receiving a message.
Wait for a new message to reply.
`,
    replyExpired: `
⚠️ **Reply Window Expired**

You had 5 minutes to reply. Please wait for a new message.
`
};

const Keyboards = {
    mainMenu: {
        inline_keyboard: [
            [{ text: "❓ Help", callback_data: "help" }, { text: "📡 Status", callback_data: "status" }]
        ]
    },
    linkedMenu: {
        inline_keyboard: [
            [{ text: "📡 Status", callback_data: "status" }, { text: "❌ Disconnect", callback_data: "disconnect" }],
            [{ text: "❓ Help", callback_data: "help" }]
        ]
    }
};

// ==========================================
//  HELPER FUNCTIONS
// ==========================================
const Helpers = {
    getUserId: async (chatId) => await redis.get(`telegram_chat:${chatId}`),
    queueReply: async (userId, payload) => {
        const listKey = `telegram_pending:${userId}`;
        await redis.rpush(listKey, JSON.stringify(payload));
        await redis.expire(listKey, CONFIG.MESSAGE_TTL);
        console.log(`[REPLY] Queued direct message for User ${userId}`);
    }
};

// ==========================================
//  CORE ACTIONS
// ==========================================
const Actions = {
    linkAccount: async (chatId, linkId) => {
        try {
            const userDataString = await redis.get(`telegram_token:${linkId}`);
            if (!userDataString) {
                return Telegram.sendMessage(chatId, "❌ **Invalid or Expired Token.**\nPlease generate a new one in-game.");
            }

            let userData;
            try { userData = JSON.parse(userDataString); } catch { userData = { userId: userDataString }; }
            const { userId, serverId } = userData;

            await redis.set(`telegram_chat:${chatId}`, userId);
            await redis.set(`telegram_user:${userId}`, chatId);
            if (serverId) await redis.hset(`telegram_metadata:${userId}`, 'server', serverId);
            await redis.del(`telegram_token:${linkId}`);

            Telegram.sendMessage(chatId, UI.linked(userId, serverId), { reply_markup: Keyboards.linkedMenu });
        } catch (error) {
            console.error("[LINK] Error:", error);
            Telegram.sendMessage(chatId, "⚠️ System Error. Please try again.");
        }
    },

    disconnectAccount: async (chatId) => {
        const userId = await Helpers.getUserId(chatId);
        if (userId) {
            await redis.del(`telegram_chat:${chatId}`);
            await redis.del(`telegram_user:${userId}`);
            Telegram.sendMessage(chatId, "🔌 **Disconnected Successfully.**", { reply_markup: Keyboards.mainMenu });
        } else {
            Telegram.sendMessage(chatId, "⚠️ You are not connected.");
        }
    },

    sendReply: async (chatId, to, content) => {
        const userId = await Helpers.getUserId(chatId);
        if (!userId) return Telegram.sendMessage(chatId, UI.notLinked);
        await Helpers.queueReply(userId, { to, content });
        Telegram.sendMessage(chatId, `📤 **Message Sent**\nTo: \`${to}\`\n"${content}"`);
    },

    sendGuildMessage: async (chatId, content) => {
        const userId = await Helpers.getUserId(chatId);
        if (!userId) return Telegram.sendMessage(chatId, UI.notLinked);
        await Helpers.queueReply(userId, { content });
        Telegram.sendMessage(chatId, `🛡️ **Guild Message Sent**\n"${content}"`);
    }
};

// ==========================================
//  WEBHOOK HANDLER
// ==========================================
module.exports = async (req, res) => {
    console.log("[WEBHOOK] Hit received!");

    try {
        const update = req.body;
        console.log("[WEBHOOK] Body:", JSON.stringify(update).substring(0, 200));

        // Handle Callback Queries (Buttons)
        if (update.callback_query) {
            console.log("[WEBHOOK] Processing Callback Query");
            const query = update.callback_query;
            const chatId = query.message.chat.id;
            const action = query.data;
            const msgId = query.message.message_id;

            await Telegram.answerCallbackQuery(query.id);

            if (action.startsWith('reply_context:')) {
                const contextId = action.split(':')[1];
                const permitString = await redis.get(`reply_permit:${chatId}:${contextId}`);

                if (!permitString) {
                    await Telegram.sendMessage(chatId, UI.replyExpired);
                } else {
                    const permit = JSON.parse(permitString);
                    await redis.set(`active_reply:${chatId}`, JSON.stringify({
                        target: permit.target,
                        type: permit.type,
                        originalMsgId: msgId
                    }), 'EX', 300);

                    await Telegram.sendMessage(chatId, `📝 **Replying to ${permit.target}...**\n\nPlease type your message now.`, {
                        reply_markup: { force_reply: true }
                    });
                }
            } else {
                switch (action) {
                    case 'help': await Telegram.sendMessage(chatId, UI.help); break;
                    case 'status':
                        const userId = await Helpers.getUserId(chatId);
                        if (userId) await Telegram.sendMessage(chatId, UI.status(userId), { reply_markup: Keyboards.linkedMenu });
                        else await Telegram.sendMessage(chatId, UI.notLinked, { reply_markup: Keyboards.mainMenu });
                        break;
                    case 'disconnect': await Actions.disconnectAccount(chatId); break;
                }
            }
        }

        // Handle Messages
        else if (update.message) {
            console.log("[WEBHOOK] Processing Message");
            const msg = update.message;
            const chatId = msg.chat.id;
            const text = msg.text || "";

            console.log(`[WEBHOOK] Chat: ${chatId}, Text: ${text}`);

            if (text.startsWith('/')) {
                console.log("[WEBHOOK] Command detected");
                if (text.startsWith('/start')) {
                    const match = text.match(/\/start(?: (.+))?/);
                    const linkId = match && match[1] ? match[1].trim() : null;

                    const existingUserId = await Helpers.getUserId(chatId);
                    if (existingUserId) {
                        await Telegram.sendMessage(chatId, UI.status(existingUserId), { reply_markup: Keyboards.linkedMenu });
                    } else if (linkId) {
                        await Actions.linkAccount(chatId, linkId);
                    } else {
                        await Telegram.sendMessage(chatId, UI.welcome(msg.from.first_name), { reply_markup: Keyboards.mainMenu });
                    }
                }
                else if (text.startsWith('/link')) {
                    const match = text.match(/\/link (.+)/);
                    if (match) await Actions.linkAccount(chatId, match[1].trim());
                }
                else if (text.startsWith('/disconnect')) {
                    await Actions.disconnectAccount(chatId);
                }
                else if (text.startsWith('/status')) {
                    const userId = await Helpers.getUserId(chatId);
                    if (userId) await Telegram.sendMessage(chatId, UI.status(userId), { reply_markup: Keyboards.linkedMenu });
                    else await Telegram.sendMessage(chatId, UI.notLinked, { reply_markup: Keyboards.mainMenu });
                }
                else if (text.startsWith('/reply')) {
                    const match = text.match(/\/reply (.+)/);
                    if (match) {
                        const lastSender = await redis.get(`last_pm_sender:${chatId}`);
                        if (lastSender) await Actions.sendReply(chatId, lastSender, match[1].trim());
                        else await Telegram.sendMessage(chatId, UI.noReplyContext);
                    }
                }
                else if (text.startsWith('/guild')) {
                    const match = text.match(/\/guild (.+)/);
                    if (match) {
                        const lastSender = await redis.get(`last_guild_sender:${chatId}`);
                        if (lastSender) await Actions.sendGuildMessage(chatId, match[1].trim());
                        else await Telegram.sendMessage(chatId, UI.noReplyContext);
                    }
                }
            } else {
                console.log("[WEBHOOK] Normal text detected");
                const activeReplyString = await redis.get(`active_reply:${chatId}`);

                if (activeReplyString) {
                    console.log("[WEBHOOK] Active reply session found");
                    const activeReply = JSON.parse(activeReplyString);
                    if (activeReply.type === 'PM') await Actions.sendReply(chatId, activeReply.target, text);
                    else if (activeReply.type === 'GUILD') await Actions.sendGuildMessage(chatId, text);

                    try {
                        await Telegram.editMessageReplyMarkup(chatId, activeReply.originalMsgId, {
                            inline_keyboard: [[{ text: "✅ Replied", callback_data: "noop" }]]
                        });
                    } catch (e) { }

                    await redis.del(`active_reply:${chatId}`);
                    await redis.del(`reply_permit:${chatId}:${activeReply.originalMsgId}`);
                } else {
                    console.log("[WEBHOOK] No active reply session. Ignoring text.");
                }
            }
        }

        console.log("[WEBHOOK] Finished processing");
        res.status(200).send('OK');
    } catch (e) {
        console.error("[WEBHOOK] Error:", e);
        res.status(200).send('Error');
    }
};
