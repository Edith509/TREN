import { Markup, Telegraf, type Context } from "telegraf";
import dotenv from "dotenv";
import type { InputMediaPhoto } from "telegraf/types";
import User from "../common/models/User.js";
import Broadcast from "../common/models/Broadcast.js";

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const MINI_APP_URL = process.env.MINI_APP_URL || "https://example.com/miniapp";
const ADMIN_MINI_APP_URL =
	process.env.ADMIN_MINI_APP_URL || "https://example.com/admin";
const START_MESSAGE =
	process.env.START_MESSAGE ||
	"Привет! Это миниапп с тренировками. Нажми кнопку ниже, чтобы открыть его.";

if (!BOT_TOKEN) {
	throw new Error("TELEGRAM_BOT_TOKEN is not defined in environment variables");
}
const bot = new Telegraf(BOT_TOKEN);

type ProfilePhoto = {
	fileId: string;
	uniqueId: string;
	url?: string;
};

type BroadcastDraft = {
	step: "await_photos" | "await_text" | "preview";
	photoFileIds: string[];
	text?: string;
	mediaGroupId?: string;
	mediaGroupTimer?: NodeJS.Timeout;
};

const broadcastDrafts = new Map<number, BroadcastDraft>();
const MAX_BROADCAST_PHOTOS = 3;
const BROADCAST_COMMAND = "\\text";

async function fetchUserProfilePhoto(
	ctx: Context,
	userId: number,
): Promise<ProfilePhoto | null> {
	try {
		const photos = await ctx.telegram.getUserProfilePhotos(userId, 0, 1);
		const firstSizes = photos.photos.at(0);
		const largestSize = firstSizes?.at(-1);

		if (!largestSize) {
			return null;
		}

		const photo: ProfilePhoto = {
			fileId: largestSize.file_id,
			uniqueId: largestSize.file_unique_id,
		};

		try {
			const fileLink = await ctx.telegram.getFileLink(largestSize.file_id);
			photo.url = fileLink.toString();
		} catch (error) {
			console.log(`Failed to load photo link: ${error}`);
		}

		return photo;
	} catch (error) {
		console.log(`Failed to load profile photo: ${error}`);
		return null;
	}
}

async function isAdminUser(telegramId: number): Promise<boolean> {
	const user = await User.findOne({ telegramId })
		.select("isAdmin")
		.lean();
	return Boolean(user?.isAdmin);
}

function getLargestPhotoFileId(ctx: Context): string | null {
	const message = ctx.message as { photo?: Array<{ file_id: string }> } | undefined;
	const photos = message?.photo;
	if (!photos?.length) return null;
	const last = photos.at(-1);
	return last ? last.file_id : null;
}

function getMediaGroupId(ctx: Context): string | null {
	const message = ctx.message as { media_group_id?: string } | undefined;
	return message?.media_group_id ?? null;
}

function clearDraft(telegramId: number) {
	const draft = broadcastDrafts.get(telegramId);
	if (draft?.mediaGroupTimer) {
		clearTimeout(draft.mediaGroupTimer);
	}
	broadcastDrafts.delete(telegramId);
}

function renderPreviewKeyboard() {
	return Markup.inlineKeyboard([
		Markup.button.callback("Отправить", "broadcast_send"),
		Markup.button.callback("Отменить", "broadcast_cancel"),
	]);
}

function formatUserName(user?: {
	firstName?: string;
	lastName?: string;
	telegramId?: number;
}): string {
	const first = user?.firstName || "";
	const last = user?.lastName || "";
	const joined = `${first} ${last}`.trim();
	if (joined) return joined;
	return user?.telegramId ? `User ${user.telegramId}` : "User";
}

async function sendBroadcastPreview(ctx: Context, draft: BroadcastDraft) {
	const text = draft.text || "";
	const photos = draft.photoFileIds;
	if (photos.length === 1) {
		const first = photos[0];
		if (!first) return;
		await ctx.replyWithPhoto(first, {
			caption: text,
			reply_markup: renderPreviewKeyboard().reply_markup,
		});
		return;
	}
	const mediaGroup: InputMediaPhoto[] = photos.map((fileId, index) => ({
		type: "photo",
		media: fileId,
		...(index === 0 ? { caption: text } : {}),
	}));
	await ctx.replyWithMediaGroup(mediaGroup);
	await ctx.reply("Предпросмотр готов. Отправить рассылку?", renderPreviewKeyboard());
}

async function sendBroadcastToChat(
	chatId: number,
	photoFileIds: string[],
	text: string,
	ctx: Context,
) {
	if (photoFileIds.length === 1) {
		const first = photoFileIds[0];
		if (!first) return;
		await ctx.telegram.sendPhoto(chatId, first, { caption: text });
		return;
	}
	const mediaGroup: InputMediaPhoto[] = photoFileIds.map((fileId, index) => ({
		type: "photo",
		media: fileId,
		...(index === 0 ? { caption: text } : {}),
	}));
	await ctx.telegram.sendMediaGroup(chatId, mediaGroup);
}

bot.start(async (ctx) => {
	const telegramUser = ctx.from;
	if (!telegramUser) {
		await ctx.reply("Привет! Напиши /start в личном чате с ботом.");
		return;
	}

	const profilePhoto = await fetchUserProfilePhoto(ctx, telegramUser.id);
	const update: Record<string, unknown> = {
		telegramId: telegramUser.id,
		isBot: telegramUser.is_bot,
		firstName: telegramUser.first_name,
		lastSeenAt: new Date(),
	};

	if (typeof telegramUser.last_name === "string") {
		update.lastName = telegramUser.last_name;
	}

	if (typeof telegramUser.username === "string") {
		update.username = telegramUser.username;
	}

	if (typeof telegramUser.language_code === "string") {
		update.languageCode = telegramUser.language_code;
	}

	if (ctx.chat?.id !== undefined) {
		update.chatId = ctx.chat.id;
	}

	if (profilePhoto) {
		update.photoFileId = profilePhoto.fileId;
		update.photoUniqueId = profilePhoto.uniqueId;
		if (profilePhoto.url) {
			update.photoUrl = profilePhoto.url;
		}
	}

	try {
		await User.findOneAndUpdate(
			{ telegramId: telegramUser.id },
			{ $set: update },
			{ upsert: true, setDefaultsOnInsert: true },
		);
	} catch (error) {
		console.log(`Failed to save user: ${error}`);
	}

	await ctx.reply(START_MESSAGE);
});

bot.command("admin", async (ctx) => {
	const telegramUser = ctx.from;
	if (!telegramUser) {
		await ctx.reply("Команда доступна только в личном чате с ботом.");
		return;
	}

	const user = await User.findOne({ telegramId: telegramUser.id })
		.select("isAdmin")
		.lean();

	if (!user?.isAdmin) {
		await ctx.reply("У вас нет доступа к админке.");
		return;
	}

	await ctx.reply(
		"Админка доступна по кнопке ниже.",
		Markup.inlineKeyboard([
			Markup.button.webApp("Открыть админку", ADMIN_MINI_APP_URL),
		]),
	);
});

bot.hears([BROADCAST_COMMAND, "/text"], async (ctx) => {
	const telegramUser = ctx.from;
	if (!telegramUser) return;
	const isAdmin = await isAdminUser(telegramUser.id);
	if (!isAdmin) {
		await ctx.reply("У вас нет доступа к рассылке.");
		return;
	}
	clearDraft(telegramUser.id);
	broadcastDrafts.set(telegramUser.id, {
		step: "await_photos",
		photoFileIds: [],
	});
	await ctx.reply(
		"Пришли до 3 фото одним сообщением (альбомом). Потом я попрошу текст.",
	);
});

bot.on("photo", async (ctx) => {
	const telegramUser = ctx.from;
	if (!telegramUser) return;
	const draft = broadcastDrafts.get(telegramUser.id);
	if (!draft || draft.step !== "await_photos") return;

	const photoId = getLargestPhotoFileId(ctx);
	if (!photoId) {
		await ctx.reply("Не удалось получить фото. Попробуй еще раз.");
		return;
	}

	if (draft.photoFileIds.length >= MAX_BROADCAST_PHOTOS) {
		await ctx.reply("Можно отправить максимум 3 фото.");
		return;
	}

	draft.photoFileIds.push(photoId);
	const mediaGroupId = getMediaGroupId(ctx);
	if (mediaGroupId) {
		draft.mediaGroupId = mediaGroupId;
		if (draft.mediaGroupTimer) {
			clearTimeout(draft.mediaGroupTimer);
		}
		draft.mediaGroupTimer = setTimeout(async () => {
			if (draft.photoFileIds.length === 0) return;
			draft.step = "await_text";
			await ctx.reply("Теперь пришли текст рассылки.");
		}, 700);
	} else {
		draft.step = "await_text";
		await ctx.reply("Фото получено. Теперь пришли текст рассылки.");
	}
});

bot.on("text", async (ctx) => {
	const telegramUser = ctx.from;
	if (!telegramUser) return;
	const text = ctx.message?.text?.trim() || "";
	const draft = broadcastDrafts.get(telegramUser.id);
	if (!draft) return;
	if (draft.step === "await_photos") {
		await ctx.reply("Сначала пришли фото (до 3).");
		return;
	}
	if (draft.step !== "await_text") return;
	if (!text) {
		await ctx.reply("Текст не может быть пустым.");
		return;
	}
	draft.text = text;
	draft.step = "preview";
	await sendBroadcastPreview(ctx, draft);
});

bot.action("broadcast_cancel", async (ctx) => {
	const telegramUser = ctx.from;
	if (!telegramUser) return;
	clearDraft(telegramUser.id);
	await ctx.answerCbQuery();
	await ctx.reply("Рассылка отменена.");
});

bot.action("broadcast_send", async (ctx) => {
	const telegramUser = ctx.from;
	if (!telegramUser) return;
	const draft = broadcastDrafts.get(telegramUser.id);
	if (!draft || draft.step !== "preview" || !draft.text) {
		await ctx.answerCbQuery("Нет данных для рассылки.");
		return;
	}
	await ctx.answerCbQuery();
	await ctx.reply("Рассылка запускается, это может занять время...");

	const users = await User.find({
		chatId: { $exists: true, $ne: null },
		isBot: { $ne: true },
	})
		.select("chatId telegramId firstName lastName")
		.lean<
			{ chatId?: number; telegramId?: number; firstName?: string; lastName?: string }[]
		>();

	let successCount = 0;
	let failedCount = 0;
	const deliveredNames: string[] = [];
	const failedNames: string[] = [];
	for (const user of users) {
		const chatId = user.chatId;
		if (!chatId) continue;
		try {
			await sendBroadcastToChat(chatId, draft.photoFileIds, draft.text, ctx);
			successCount += 1;
			deliveredNames.push(formatUserName(user));
		} catch (error) {
			failedCount += 1;
			failedNames.push(formatUserName(user));
		}
	}

	await Broadcast.create({
		adminTelegramId: telegramUser.id,
		text: draft.text,
		photoFileIds: draft.photoFileIds,
		totalRecipients: successCount + failedCount,
		successCount,
		failedCount,
	});

	const totalBroadcasts = await Broadcast.countDocuments();
	if (totalBroadcasts > 500) {
		const extra = totalBroadcasts - 500;
		const oldIds = await Broadcast.find()
			.sort({ createdAt: 1 })
			.limit(extra)
			.select("_id")
			.lean<{ _id: string }[]>();
		if (oldIds.length) {
			await Broadcast.deleteMany({ _id: { $in: oldIds.map((item) => item._id) } });
		}
	}

	clearDraft(telegramUser.id);
	const deliveredPreview = deliveredNames.slice(0, 20).join(", ") || "нет";
	const failedPreview = failedNames.slice(0, 20).join(", ") || "нет";
	await ctx.reply(
		`Готово. Отправлено: ${successCount}, ошибок: ${failedCount}, всего: ${successCount + failedCount}.\n` +
			`Дошло: ${deliveredPreview}\n` +
			`Не дошло: ${failedPreview}`,
	);

	const hasOverflow =
		deliveredNames.length > 20 || failedNames.length > 20;
	if (hasOverflow) {
		const reportLines = [
			"Delivered:",
			...deliveredNames,
			"",
			"Failed:",
			...failedNames,
			"",
		];
		const reportText = reportLines.join("\n");
		await ctx.replyWithDocument({
			source: Buffer.from(reportText, "utf8"),
			filename: "broadcast-report.txt",
		});
	}
});

bot.catch((error) => {
	console.log(`Bot error: ${error}`);
});

export async function startBot(): Promise<void> {
	await bot.launch();
	console.log("Telegram bot is running");

	process.once("SIGINT", () => bot.stop("SIGINT"));
	process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
