import { Markup, Telegraf, type Context } from "telegraf";
import dotenv from "dotenv";
import User from "../common/models/User.js";

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

	await ctx.reply(
		START_MESSAGE,
		Markup.inlineKeyboard([Markup.button.webApp("Открыть миниапп", MINI_APP_URL)]),
	);
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

bot.catch((error) => {
	console.log(`Bot error: ${error}`);
});

export async function startBot(): Promise<void> {
	await bot.launch();
	console.log("Telegram bot is running");

	process.once("SIGINT", () => bot.stop("SIGINT"));
	process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
