const Redis = require('ioredis');

const CONFIG = {
    TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    REDIS_URL: process.env.REDIS_URL,
    REPLY_WINDOW: 300
};

if (!CONFIG.TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is missing");

const redis = new Redis(CONFIG.REDIS_URL, {
    retryStrategy: (times) => Math.min(times * 50, 2000),
    maxRetriesPerRequest: 3,
    connectTimeout: 10000,
    lazyConnect: true,
    family: 0
});

redis.on('error', (err) => console.error('[REDIS] Error:', err));
redis.on('connect', () => console.log('[REDIS] Connected'));

const Helpers = {
    getChatId: async (userId) => await redis.get(`telegram_user:${userId}`),
    sendMessage: async (chatId, text, options = {}) => {
        const url = `https://api.telegram.org/bot${CONFIG.TOKEN}/sendMessage`;
        const body = {
            chat_id: chatId,
            text: text,
            parse_mode: 'Markdown',
            ...options
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        const data = await response.json();
        if (!data.ok) {
            throw new Error(`Telegram API Error: ${data.description}`);
        }
        return data;
    }
};

// ==========================================
//  NOTIFICATION HANDLER (Server -> Bot)
// ==========================================
module.exports = async (req, res) => {
    console.log("[NOTIFY] Hit received!");

    try {
        const { userId, text, chatId: payloadChatId } = req.body;
        console.log(`[NOTIFY] Body: userId=${userId}, text=${text ? text.substring(0, 50) : 'null'}`);

        if (!userId || !text) return res.status(400).json({ error: "Missing userId or text" });

        // Lookup Chat ID
        const chatId = payloadChatId || await Helpers.getChatId(userId);
        console.log(`[NOTIFY] Chat ID lookup: ${chatId}`);

        if (chatId) {
            let formattedText = text;
            if (!text.includes('**')) {
                formattedText = `🔔 **Notification**\n\n${text}`;
            }

            // Context Parsing (PM/Guild)
            const pmMatch = text.match(/New Private Message\*\*\\nFrom: (.+?)\\n/);
            const guildMatch = text.match(/New Guild Message\*\*\\nFrom: (.+?)\\n/);
            const simpleFromMatch = text.match(/From: (.+?)(\n|$)/);

            let replyMarkup = null;
            const contextId = Date.now().toString();

            if (text.includes("Private Message") && (pmMatch || simpleFromMatch)) {
                const sender = pmMatch ? pmMatch[1] : simpleFromMatch[1];
                await redis.set(`last_pm_sender:${chatId}`, sender, 'EX', CONFIG.REPLY_WINDOW);
                await redis.set(`reply_permit:${chatId}:${contextId}`, JSON.stringify({ target: sender, type: 'PM' }), 'EX', CONFIG.REPLY_WINDOW);
                replyMarkup = { inline_keyboard: [[{ text: "↩️ Reply (5 min)", callback_data: `reply_context:${contextId}` }]] };
            }
            else if (text.includes("Guild Message")) {
                const sender = guildMatch ? guildMatch[1] : (simpleFromMatch ? simpleFromMatch[1] : "Guild");
                await redis.set(`last_guild_sender:${chatId}`, sender, 'EX', CONFIG.REPLY_WINDOW);
                await redis.set(`reply_permit:${chatId}:${contextId}`, JSON.stringify({ target: sender, type: 'GUILD' }), 'EX', CONFIG.REPLY_WINDOW);
                replyMarkup = { inline_keyboard: [[{ text: "🛡️ Reply to Guild (5 min)", callback_data: `reply_context:${contextId}` }]] };
            }

            const options = {};
            if (replyMarkup) options.reply_markup = replyMarkup;

            console.log(`[NOTIFY] Sending message to ${chatId} via fetch...`);
            await Helpers.sendMessage(chatId, formattedText, options);
            console.log(`[NOTIFY] Sent successfully to User ${userId}`);

            res.json({ success: true });
        } else {
            console.log(`[NOTIFY] User ${userId} not linked (No Chat ID)`);
            res.status(404).json({ error: "User not linked" });
        }
    } catch (e) {
        console.error("[NOTIFY] Error:", e);
        res.status(500).json({ error: e.message });
    }
};
