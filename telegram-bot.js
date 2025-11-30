const TelegramBot = require('node-telegram-bot-api');
const Redis = require('ioredis');
require('dotenv').config();

// ==========================================
//  CONFIGURATION & CONSTANTS
// ==========================================
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const REDIS_URL = process.env.REDIS_URL;

if (!TOKEN) {
    console.error("❌ Error: TELEGRAM_BOT_TOKEN is missing.");
    process.exit(1);
}

// Initialize Services
const bot = new TelegramBot(TOKEN, { polling: true });
const redis = new Redis(REDIS_URL);
const redisSub = new Redis(REDIS_URL);

// Redis Events
redis.on('connect', () => console.log('✅ Redis (Command) Connected'));
redis.on('error', (err) => console.error('❌ Redis (Command) Error:', err));
redisSub.on('connect', () => console.log('✅ Redis (Sub) Connected'));
redisSub.on('error', (err) => console.error('❌ Redis (Sub) Error:', err));

console.log('🤖 Telegram Bot 2.0 Started...');

// ==========================================
//  UI HELPERS
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
/reply <Player> <Msg> - Send Message
/guild <Msg> - Guild Chat
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
                [{ text: "📝 Reply", callback_data: "reply_btn" }, { text: "🛡️ Guild", callback_data: "guild_btn" }],
                [{ text: "📡 Status", callback_data: "status" }, { text: "❌ Disconnect", callback_data: "disconnect" }],
                [{ text: "❓ Help", callback_data: "help" }]
            ]
        }
    }
};

// ==========================================
//  CORE LOGIC
// ==========================================

// 1. Link Account
const linkAccount = async (chatId, linkId) => {
    console.log(`[LINK] Processing token: ${linkId} for Chat: ${chatId}`);
    try {
        const userDataString = await redis.get(`telegram_token:${linkId}`);

        if (!userDataString) {
            return bot.sendMessage(chatId, "❌ **Invalid or Expired Token.**\nPlease generate a new one in-game.", { parse_mode: 'Markdown' });
        }

        let userData;
        try { userData = JSON.parse(userDataString); } catch { userData = { userId: userDataString }; }

        const { userId, serverId, language } = userData;

        // Save Link
        await redis.set(`telegram_chat:${chatId}`, userId);
        await redis.set(`telegram_user:${userId}`, chatId);
        if (serverId) await redis.hset(`telegram_metadata:${userId}`, 'server', serverId);

        // Cleanup
        await redis.del(`telegram_token:${linkId}`);

        bot.sendMessage(chatId, UI.linked(userId, serverId), { parse_mode: 'Markdown', ...Keyboards.linkedMenu });
        console.log(`[LINK] Success: User ${userId} -> Chat ${chatId}`);

    } catch (error) {
        console.error("[LINK] Error:", error);
        bot.sendMessage(chatId, "⚠️ System Error. Please try again.");
    }
};

// ==========================================
//  COMMAND HANDLERS
// ==========================================

// /start
bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const linkId = match[1] ? match[1].trim() : null;

    if (linkId) {
        return await linkAccount(chatId, linkId);
    }

    const userId = await redis.get(`telegram_chat:${chatId}`);
    if (userId) {
        bot.sendMessage(chatId, UI.status(userId), { parse_mode: 'Markdown', ...Keyboards.linkedMenu });
    } else {
        bot.sendMessage(chatId, UI.welcome(msg.from.first_name), { parse_mode: 'Markdown', ...Keyboards.mainMenu });
    }
});

// /link
bot.onText(/\/link (.+)/, async (msg, match) => {
    await linkAccount(msg.chat.id, match[1].trim());
});

// /disconnect
bot.onText(/\/disconnect/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = await redis.get(`telegram_chat:${chatId}`);

    if (userId) {
        await redis.del(`telegram_chat:${chatId}`);
        await redis.del(`telegram_user:${userId}`);
        bot.sendMessage(chatId, "🔌 **Disconnected Successfully.**", { parse_mode: 'Markdown', ...Keyboards.mainMenu });
    } else {
        bot.sendMessage(chatId, "⚠️ You are not connected.", { parse_mode: 'Markdown' });
    }
});

// /status
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = await redis.get(`telegram_chat:${chatId}`);

    if (userId) {
        bot.sendMessage(chatId, UI.status(userId), { parse_mode: 'Markdown', ...Keyboards.linkedMenu });
    } else {
        bot.sendMessage(chatId, UI.notLinked, { parse_mode: 'Markdown', ...Keyboards.mainMenu });
    }
});

// /reply
bot.onText(/\/reply (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = await redis.get(`telegram_chat:${chatId}`);
    if (!userId) return bot.sendMessage(chatId, UI.notLinked, { parse_mode: 'Markdown' });

    const fullText = match[1].trim();
    const firstSpace = fullText.indexOf(' ');
    if (firstSpace === -1) return bot.sendMessage(chatId, "⚠️ Usage: `/reply <Player> <Message>`", { parse_mode: 'Markdown' });

    const to = fullText.substring(0, firstSpace);
    const content = fullText.substring(firstSpace + 1);

    // CRITICAL FIX: Write directly to Redis Queue (Serverless compatible)
    // We push to the list that the client polls
    await redis.rpush(`telegram_pending:${userId}`, JSON.stringify({ to, content }));
    await redis.expire(`telegram_pending:${userId}`, 86400); // 24h expiry

    bot.sendMessage(chatId, `📤 **Message Sent**\nTo: \`${to}\`\n"${content}"`, { parse_mode: 'Markdown' });
});

// /guild
bot.onText(/\/guild (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = await redis.get(`telegram_chat:${chatId}`);
    if (!userId) return bot.sendMessage(chatId, UI.notLinked, { parse_mode: 'Markdown' });

    const content = match[1].trim();
    // CRITICAL FIX: Write directly to Redis Queue (Serverless compatible)
    await redis.rpush(`telegram_pending:${userId}`, JSON.stringify({ to: 'Guild', content }));
    await redis.expire(`telegram_pending:${userId}`, 86400);

    bot.sendMessage(chatId, `🛡️ **Guild Message Sent**\n"${content}"`, { parse_mode: 'Markdown' });
});

// ==========================================
//  INTERACTIVE HANDLERS (ForceReply)
// ==========================================
bot.on('message', async (msg) => {
    // Check if this is a reply to our ForceReply prompt
    if (msg.reply_to_message && msg.reply_to_message.from.is_bot) {
        const promptText = msg.reply_to_message.text;
        const chatId = msg.chat.id;
        const userId = await redis.get(`telegram_chat:${chatId}`);

        if (!userId) return; // Should not happen if they saw the button, but safety first

        if (promptText.includes("Guild Message")) {
            // Handle Guild Message
            const content = msg.text;
            // CRITICAL FIX: Write directly to Redis Queue
            await redis.rpush(`telegram_pending:${userId}`, JSON.stringify({ to: 'Guild', content }));
            await redis.expire(`telegram_pending:${userId}`, 86400);

            bot.sendMessage(chatId, `🛡️ **Guild Message Sent**\n"${content}"`, { parse_mode: 'Markdown' });
        } else if (promptText.includes("Reply to Player")) {
            // Handle Player Reply
            const fullText = msg.text.trim();
            const firstSpace = fullText.indexOf(' ');

            if (firstSpace === -1) {
                bot.sendMessage(chatId, "⚠️ Invalid Format. Please try again: `PlayerName Message`", { parse_mode: 'Markdown' });
            } else {
                const to = fullText.substring(0, firstSpace);
                const content = fullText.substring(firstSpace + 1);
                // CRITICAL FIX: Write directly to Redis Queue
                await redis.rpush(`telegram_pending:${userId}`, JSON.stringify({ to, content }));
                await redis.expire(`telegram_pending:${userId}`, 86400);

                bot.sendMessage(chatId, `📤 **Message Sent**\nTo: \`${to}\`\n"${content}"`, { parse_mode: 'Markdown' });
            }
        }
    }
});

// ==========================================
//  CALLBACK QUERY HANDLER (Buttons)
// ==========================================
// ==========================================
//  NOTIFICATION LISTENER
// ==========================================
redisSub.subscribe('telegram_notifications', (err) => {
    if (!err) console.log('✅ Listening for Notifications...');
});

redisSub.on('message', async (channel, message) => {
    if (channel !== 'telegram_notifications') return;

    try {
        const { userId, text } = JSON.parse(message);
        if (!userId || !text) return;

        const chatId = await redis.get(`telegram_user:${userId}`);
        if (chatId) {
            // Add a nice header if it's a plain text message
            let formattedText = text;
            if (!text.includes('**')) {
                formattedText = `🔔 **Notification**\n\n${text}`;
            }
            bot.sendMessage(chatId, formattedText, { parse_mode: 'Markdown' });
            console.log(`[NOTIFY] Sent to User ${userId}`);
        }
    } catch (e) {
        console.error("[NOTIFY] Error:", e);
    }
});
