const TelegramBot = require('node-telegram-bot-api');
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

// Initialize Bot (No Polling for Serverless)
const bot = new TelegramBot(CONFIG.TOKEN);

// Initialize Redis
const redis = new Redis(CONFIG.REDIS_URL, {
    retryStrategy: (times) => Math.min(times * 50, 2000)
});

// ==========================================
//  UI & TEXT ASSETS (Copied from original)
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
        reply_markup: {
            inline_keyboard: [
                [{ text: "❓ Help", callback_data: "help" }, { text: "📡 Status", callback_data: "status" }]
            ]
        }
    },
    linkedMenu: {
        reply_markup: {
            inline_keyboard: [
                [{ text: "📡 Status", callback_data: "status" }, { text: "❌ Disconnect", callback_data: "disconnect" }],
                [{ text: "❓ Help", callback_data: "help" }]
            ]
        }
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
                return bot.sendMessage(chatId, "❌ **Invalid or Expired Token.**\nPlease generate a new one in-game.", { parse_mode: 'Markdown' });
            }

            let userData;
            try { userData = JSON.parse(userDataString); } catch { userData = { userId: userDataString }; }
            const { userId, serverId } = userData;

            await redis.set(`telegram_chat:${chatId}`, userId);
            await redis.set(`telegram_user:${userId}`, chatId);
            if (serverId) await redis.hset(`telegram_metadata:${userId}`, 'server', serverId);
            await redis.del(`telegram_token:${linkId}`);

            bot.sendMessage(chatId, UI.linked(userId, serverId), { parse_mode: 'Markdown', ...Keyboards.linkedMenu });
        } catch (error) {
            console.error("[LINK] Error:", error);
            bot.sendMessage(chatId, "⚠️ System Error. Please try again.");
        }
    },

    disconnectAccount: async (chatId) => {
        const userId = await Helpers.getUserId(chatId);
        if (userId) {
            await redis.del(`telegram_chat:${chatId}`);
            await redis.del(`telegram_user:${userId}`);
            bot.sendMessage(chatId, "🔌 **Disconnected Successfully.**", { parse_mode: 'Markdown', ...Keyboards.mainMenu });
        } else {
            bot.sendMessage(chatId, "⚠️ You are not connected.", { parse_mode: 'Markdown' });
        }
    },

    sendReply: async (chatId, to, content) => {
        const userId = await Helpers.getUserId(chatId);
        if (!userId) return bot.sendMessage(chatId, UI.notLinked, { parse_mode: 'Markdown' });
        await Helpers.queueReply(userId, { to, content });
        bot.sendMessage(chatId, `📤 **Message Sent**\nTo: \`${to}\`\n"${content}"`, { parse_mode: 'Markdown' });
    },

    sendGuildMessage: async (chatId, content) => {
        const userId = await Helpers.getUserId(chatId);
        if (!userId) return bot.sendMessage(chatId, UI.notLinked, { parse_mode: 'Markdown' });
        await Helpers.queueReply(userId, { content });
        bot.sendMessage(chatId, `🛡️ **Guild Message Sent**\n"${content}"`, { parse_mode: 'Markdown' });
    }
};

// ==========================================
//  WEBHOOK HANDLER
// ==========================================
module.exports = async (req, res) => {
    try {
        const update = req.body;

        // Handle Callback Queries (Buttons)
        if (update.callback_query) {
            const query = update.callback_query;
            const chatId = query.message.chat.id;
            const action = query.data;
            const msgId = query.message.message_id;

            await bot.answerCallbackQuery(query.id);

            if (action.startsWith('reply_context:')) {
                const contextId = action.split(':')[1];
                const permitString = await redis.get(`reply_permit:${chatId}:${contextId}`);

                if (!permitString) {
                    await bot.sendMessage(chatId, UI.replyExpired, { parse_mode: 'Markdown' });
                } else {
                    const permit = JSON.parse(permitString);
                    await redis.set(`active_reply:${chatId}`, JSON.stringify({
                        target: permit.target,
                        type: permit.type,
                        originalMsgId: msgId
                    }), 'EX', 300);

                    await bot.sendMessage(chatId, `📝 **Replying to ${permit.target}...**\n\nPlease type your message now.`, {
                        parse_mode: 'Markdown',
                        reply_markup: { force_reply: true }
                    });
                }
            } else {
                switch (action) {
                    case 'help': await bot.sendMessage(chatId, UI.help, { parse_mode: 'Markdown' }); break;
                    case 'status':
                        const userId = await Helpers.getUserId(chatId);
                        if (userId) await bot.sendMessage(chatId, UI.status(userId), { parse_mode: 'Markdown', ...Keyboards.linkedMenu });
                        else await bot.sendMessage(chatId, UI.notLinked, { parse_mode: 'Markdown', ...Keyboards.mainMenu });
                        break;
                    case 'disconnect': await Actions.disconnectAccount(chatId); break;
                }
            }
        }

        // Handle Messages
        else if (update.message) {
            const msg = update.message;
            const chatId = msg.chat.id;
            const text = msg.text || "";

            if (text.startsWith('/')) {
                // Commands
                if (text.startsWith('/start')) {
                    const match = text.match(/\/start(?: (.+))?/);
                    const linkId = match && match[1] ? match[1].trim() : null;
                    const existingUserId = await Helpers.getUserId(chatId);

                    if (existingUserId) {
                        await bot.sendMessage(chatId, UI.status(existingUserId), { parse_mode: 'Markdown', ...Keyboards.linkedMenu });
                    } else if (linkId) {
                        await Actions.linkAccount(chatId, linkId);
                    } else {
                        await bot.sendMessage(chatId, UI.welcome(msg.from.first_name), { parse_mode: 'Markdown', ...Keyboards.mainMenu });
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
                    if (userId) await bot.sendMessage(chatId, UI.status(userId), { parse_mode: 'Markdown', ...Keyboards.linkedMenu });
                    else await bot.sendMessage(chatId, UI.notLinked, { parse_mode: 'Markdown', ...Keyboards.mainMenu });
                }
                else if (text.startsWith('/reply')) {
                    const match = text.match(/\/reply (.+)/);
                    if (match) {
                        const lastSender = await redis.get(`last_pm_sender:${chatId}`);
                        if (lastSender) await Actions.sendReply(chatId, lastSender, match[1].trim());
                        else await bot.sendMessage(chatId, UI.noReplyContext, { parse_mode: 'Markdown' });
                    }
                }
                else if (text.startsWith('/guild')) {
                    const match = text.match(/\/guild (.+)/);
                    if (match) {
                        const lastSender = await redis.get(`last_guild_sender:${chatId}`);
                        if (lastSender) await Actions.sendGuildMessage(chatId, match[1].trim());
                        else await bot.sendMessage(chatId, UI.noReplyContext, { parse_mode: 'Markdown' });
                    }
                }
            } else {
                // Normal Text (Check for Active Reply)
                const activeReplyString = await redis.get(`active_reply:${chatId}`);
                if (activeReplyString) {
                    const activeReply = JSON.parse(activeReplyString);
                    if (activeReply.type === 'PM') await Actions.sendReply(chatId, activeReply.target, text);
                    else if (activeReply.type === 'GUILD') await Actions.sendGuildMessage(chatId, text);

                    // Update Original Button
                    try {
                        await bot.editMessageReplyMarkup({
                            inline_keyboard: [[{ text: "✅ Replied", callback_data: "noop" }]]
                        }, { chat_id: chatId, message_id: activeReply.originalMsgId });
                    } catch (e) { }

                    await redis.del(`active_reply:${chatId}`);
                    await redis.del(`reply_permit:${chatId}:${activeReply.originalMsgId}`);
                }
            }
        }

        res.status(200).send('OK');
    } catch (e) {
        console.error("Webhook Error:", e);
        res.status(500).send('Error');
    }
};
