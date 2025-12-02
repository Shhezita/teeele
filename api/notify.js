const TelegramBot = require('node-telegram-bot-api');
const Redis = require('ioredis');

const CONFIG = {
    TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    REDIS_URL: process.env.REDIS_URL,
    REPLY_WINDOW: 300
};

if (!CONFIG.TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is missing");

const bot = new TelegramBot(CONFIG.TOKEN);
const redis = new Redis(CONFIG.REDIS_URL, {
    retryStrategy: (times) => Math.min(times * 50, 2000)
});

const Helpers = {
    getChatId: async (userId) => await redis.get(`telegram_user:${userId}`)
};

// ==========================================
//  NOTIFICATION HANDLER (Server -> Bot)
// ==========================================
module.exports = async (req, res) => {
    // Basic Auth (Optional but recommended: check a secret header)
    // if (req.headers['x-bot-secret'] !== process.env.BOT_SECRET) return res.status(401).send('Unauthorized');

    try {
        const { userId, text, chatId: payloadChatId } = req.body;

        if (!userId || !text) return res.status(400).json({ error: "Missing userId or text" });

        console.log(`[BOT] Received Notification for User ${userId}`);

        // Lookup Chat ID
        const chatId = payloadChatId || await Helpers.getChatId(userId);

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

            const options = { parse_mode: 'Markdown' };
            if (replyMarkup) options.reply_markup = replyMarkup;

            await bot.sendMessage(chatId, formattedText, options);
            console.log(`[NOTIFY] Sent to User ${userId}`);

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
