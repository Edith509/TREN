import express from "express";
import User from "../models/User.js";
import { logAppError } from "../utils/logAppError.js";
import { parseTelegramId } from "./utils.js";

const router = express.Router();

router.get("/health", (_req, res) => {
	res.status(200).json({ status: "OK", message: "API is healthy" });
});

router.get("/api/telegram/avatar/:telegramId", async (req, res) => {
	try {
		const telegramId = parseTelegramId(req.params.telegramId);
		if (!telegramId) {
			res.status(400).send("Invalid telegramId");
			return;
		}

		const user = await User.findOne({ telegramId })
			.select("photoFileId")
			.lean<{ photoFileId?: string } | null>();

		const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
		if (!botToken) {
			res.status(500).send("Bot token not configured");
			return;
		}

		const fetchFilePath = async (fileId: string) => {
			const fileMeta = await fetch(
				`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(
					fileId,
				)}`,
			);
			if (!fileMeta.ok) return null;
			const fileMetaJson = (await fileMeta.json()) as {
				ok?: boolean;
				result?: { file_path?: string };
			};
			return fileMetaJson.ok ? fileMetaJson.result?.file_path ?? null : null;
		};

		const refreshPhotoFileId = async (): Promise<string | null> => {
			const res = await fetch(
				`https://api.telegram.org/bot${botToken}/getUserProfilePhotos?user_id=${telegramId}&limit=1`,
			);
			if (!res.ok) return null;
			const data = (await res.json()) as {
				ok?: boolean;
				result?: { photos?: Array<Array<{ file_id: string }>> };
			};
			const fileId = data.ok
				? data.result?.photos?.[0]?.at(-1)?.file_id ?? null
				: null;
			if (fileId) {
				await User.updateOne({ telegramId }, { $set: { photoFileId: fileId } });
			}
			return fileId;
		};

		let fileId: string | null = user?.photoFileId ?? null;
		if (!fileId) {
			fileId = await refreshPhotoFileId();
		}
		let filePath = fileId ? await fetchFilePath(fileId) : null;
		if (!filePath) {
			fileId = await refreshPhotoFileId();
			filePath = fileId ? await fetchFilePath(fileId) : null;
		}
		if (!filePath) {
			res.status(404).send("Photo not found");
			return;
		}

		const fileRes = await fetch(
			`https://api.telegram.org/file/bot${botToken}/${filePath}`,
		);
		if (!fileRes.ok) {
			res.status(502).send("Failed to fetch file");
			return;
		}
		const contentType = fileRes.headers.get("content-type") || "image/jpeg";
		const buffer = Buffer.from(await fileRes.arrayBuffer());
		res.setHeader("Content-Type", contentType);
		res.setHeader("Cache-Control", "public, max-age=3600");
		res.send(buffer);
	} catch (error) {
		await logAppError(error, {
			source: "api",
			path: req.path,
			method: req.method,
			status: 500,
		});
		res.status(500).send("Avatar error");
	}
});

export default router;
