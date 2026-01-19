type TelegramRecipient = {
	chatId?: number;
	telegramId?: number;
};

export function resolveTelegramChatId(recipient?: TelegramRecipient | null): number | null {
	if (!recipient) return null;
	if (typeof recipient.chatId === "number") return recipient.chatId;
	if (typeof recipient.telegramId === "number") return recipient.telegramId;
	return null;
}

export async function sendTelegramMessage(
	chatId: number,
	text: string,
): Promise<void> {
	const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
	if (!botToken || !chatId || !text) return;

	const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			chat_id: chatId,
			text,
		}),
	});

	if (!res.ok) {
		const details = await res.text().catch(() => "");
		throw new Error(`Telegram sendMessage failed: ${res.status} ${details}`);
	}
}
