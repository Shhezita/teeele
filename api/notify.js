// ==========================================
//  CONFIGURATION
// ==========================================
const CONFIG = {
    TOKEN: process.env.TELEGRAM_BOT_TOKEN
};

if (!CONFIG.TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is missing");

// ==========================================
//  TELEGRAM API HELPER (Native Fetch)
// ==========================================
const Telegram = {
    sendMessage: async (chatId, text, options = {}) => {
        const url = `https://api.telegram.org/bot${CONFIG.TOKEN}/sendMessage`;
        try {
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
                console.error(`[TELEGRAM] Error sending message:`, data.description);
                throw new Error(data.description);
            }
            return data;
        } catch (e) {
            console.error(`[TELEGRAM] Network Error:`, e);
            throw e;
        }
    }
};

// ==========================================
//  NOTIFICATION HANDLER (Stateless Proxy)
// ==========================================
module.exports = async (req, res) => {
    console.log("[NOTIFY] Hit received!");

    try {
        const { userId, text, chatId, replyContext } = req.body;
        console.log(`[NOTIFY] Body: userId=${userId}, chatId=${chatId}, text=${text ? text.substring(0, 50) : 'null'}`);

        if (!chatId || !text) {
            console.error("[NOTIFY] Missing chatId or text. (Redis lookup must happen in Game Server)");
            return res.status(400).json({ error: "Missing chatId or text" });
        }

        let formattedText = text;
        if (!text.includes('**')) {
            formattedText = `🔔 **Notification**\n\n${text}`;
        }

        const options = {};

        // If Game Server passed reply context, add button
        // (For now, we rely on the text content or passed context if we implement it fully)
        // But since we moved context saving to Game Server, we can just send the message.
        // If we want buttons, we can add logic here purely based on text regex, 
        // OR pass the button structure from Game Server.
        // For simplicity and speed, let's add the button if text matches, 
        // but WITHOUT saving state (State is already saved in Game Server).

        const pmMatch = text.match(/New Private Message\*\*\\nFrom: (.+?)\\n/);
        const guildMatch = text.match(/New Guild Message\*\*\\nFrom: (.+?)\\n/);
        const simpleFromMatch = text.match(/From: (.+?)(\n|$)/);

        let replyMarkup = null;
        const contextId = Date.now().toString(); // Just for the button callback, state is in Redis

        if (text.includes("Private Message") && (pmMatch || simpleFromMatch)) {
            replyMarkup = { inline_keyboard: [[{ text: "↩️ Reply (5 min)", callback_data: `reply_context:${contextId}` }]] };
        }
        else if (text.includes("Guild Message")) {
            replyMarkup = { inline_keyboard: [[{ text: "🛡️ Reply to Guild (5 min)", callback_data: `reply_context:${contextId}` }]] };
        }

        if (replyMarkup) options.reply_markup = replyMarkup;

        console.log(`[NOTIFY] Sending message to ${chatId}...`);
        await Telegram.sendMessage(chatId, formattedText, options);
        console.log(`[NOTIFY] Sent successfully to User ${userId}`);

        res.json({ success: true });

    } catch (e) {
        console.error("[NOTIFY] Error:", e);
        res.status(500).json({ error: e.message });
    }
};
