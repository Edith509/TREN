import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { Request, Response } from "express";
import express from "express";
import * as XLSX from "xlsx";

import Order from "../models/Orders.js";
import TrainingGoal from "../models/TrainingGoal.js";
import User from "../models/User.js";
import AppError from "../models/AppError.js";
import { logAppError } from "../utils/logAppError.js";

const router = express.Router();
const uploadsDir = path.resolve("public", "uploads");
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const excelMimeTypes = new Set([
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const excelExtensions = new Set([".xls", ".xlsx"]);
const OLE_HEADER = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

type GoalDoc = { title?: string };
type OrderDoc = {
	_id: string;
	fullName?: string;
	phoneNumber?: string;
	telegramUserId: number;
	adminTelegramId?: number;
	status: string;
	trainingDate?: Date;
	goalId?: GoalDoc | null;
	medicalContraindications?: string;
	age?: number;
	weightKg?: number;
	heightCm?: number;
	attachmentUrl?: string;
	attachmentFileName?: string;
	attachmentMimeType?: string;
	completedAt?: Date;
	createdAt?: Date;
};

type UserDoc = {
	telegramId: number;
	firstName?: string;
	lastName?: string;
	username?: string;
	photoUrl?: string;
	fullName?: string;
	phoneNumber?: string;
	isAdmin?: boolean;
	trainingStatus?: string;
};

type TelegramInitUser = {
	id: number;
	first_name?: string;
	last_name?: string;
	username?: string;
	photo_url?: string;
	language_code?: string;
};

function parseTelegramId(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function safeEqualHex(left: string, right: string): boolean {
	const leftNorm = left.toLowerCase();
	const rightNorm = right.toLowerCase();
	const leftBuf = Buffer.from(leftNorm, "hex");
	const rightBuf = Buffer.from(rightNorm, "hex");
	if (leftBuf.length !== rightBuf.length) return false;
	return crypto.timingSafeEqual(leftBuf, rightBuf);
}

function extractInitData(req: Request): string | null {
	const headerValue = req.header("x-telegram-init-data");
	if (typeof headerValue === "string" && headerValue.trim()) {
		return headerValue;
	}
	const queryValue = req.query.initData;
	if (typeof queryValue === "string" && queryValue.trim()) {
		return queryValue;
	}
	const bodyValue =
		typeof req.body === "object" && req.body !== null
			? (req.body as Record<string, unknown>).initData
			: undefined;
	if (typeof bodyValue === "string" && bodyValue.trim()) {
		return bodyValue;
	}
	return null;
}

function parseInitDataUser(initData: string): TelegramInitUser | null {
	const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
	if (!initData || !botToken) return null;
	const params = new URLSearchParams(initData);
	const hash = params.get("hash");
	if (!hash) return null;
	params.delete("hash");

	const dataCheckString = Array.from(params.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");

	const secret = crypto
		.createHmac("sha256", "WebAppData")
		.update(botToken)
		.digest();
	const calculated = crypto
		.createHmac("sha256", secret)
		.update(dataCheckString)
		.digest("hex");

	if (!safeEqualHex(calculated, hash)) return null;

	const userRaw = params.get("user");
	if (!userRaw) return null;
	try {
		const user = JSON.parse(userRaw) as TelegramInitUser;
		return typeof user?.id === "number" ? user : null;
	} catch {
		return null;
	}
}

function resolveInitDataTelegramId(req: Request): number | null {
	const initData = extractInitData(req);
	if (!initData) return null;
	const user = parseInitDataUser(initData);
	return user?.id ?? null;
}

function resolveAdminTelegramId(req: Request): number | null {
	const initDataId = resolveInitDataTelegramId(req);
	if (initDataId) return initDataId;
	const queryValue = req.query.adminTelegramId;
	const bodyValue =
		typeof req.body === "object" && req.body !== null
			? (req.body as Record<string, unknown>).adminTelegramId
			: undefined;
	const envValue = process.env.ADMIN_TELEGRAM_ID;
	return (
		parseTelegramId(queryValue) ??
		parseTelegramId(bodyValue) ??
		parseTelegramId(envValue)
	);
}

function withAdminContext(
	req: Request,
	base: { source: string; path?: string; method?: string; status?: number },
) {
	const adminTelegramId = resolveAdminTelegramId(req);
	return adminTelegramId ? { ...base, adminTelegramId } : base;
}

function resolveTelegramUserId(req: Request): number | null {
	const initDataId = resolveInitDataTelegramId(req);
	if (initDataId) return initDataId;
	const queryValue = req.query.telegramId;
	const bodyValue =
		typeof req.body === "object" && req.body !== null
			? (req.body as Record<string, unknown>).telegramId
			: undefined;
	const headerValue = req.header("x-telegram-id");
	return (
		parseTelegramId(queryValue) ??
		parseTelegramId(bodyValue) ??
		parseTelegramId(headerValue)
	);
}

function extractGoalTitle(goal?: GoalDoc | null): string | undefined {
	if (!goal) return undefined;
	if (typeof goal === "object" && "title" in goal) {
		return goal.title;
	}
	return undefined;
}

function getMimeTypeFromData(data?: string): string | undefined {
	const parsed = parseDataUrl(data);
	return parsed.mimeType;
}

function parseDataUrl(
	data?: string,
): { mimeType?: string; base64?: string } {
	if (!data || !data.startsWith("data:")) return {};
	const commaIndex = data.indexOf(",");
	if (commaIndex === -1) return {};
	const meta = data.slice(5, commaIndex);
	const base64 = data.slice(commaIndex + 1);
	const metaParts = meta.split(";").filter(Boolean);
	const mimeType = metaParts[0];
	const isBase64 = metaParts.includes("base64");
	const result: { mimeType?: string; base64?: string } = {};
	if (mimeType) {
		result.mimeType = mimeType;
	}
	if (isBase64) {
		result.base64 = base64;
	}
	return result;
}

function detectExcelExtension(
	buffer: Buffer,
	originalName?: string,
	mimeType?: string,
): string {
	const extFromName = originalName
		? path.extname(originalName).slice(1).toLowerCase()
		: "";
	const isZip = buffer.slice(0, 2).toString("utf8") === "PK";
	const isOle = buffer.slice(0, OLE_HEADER.length).equals(OLE_HEADER);

	if (isZip) return "xlsx";
	if (isOle) return "xls";

	if (extFromName) return extFromName;
	if (mimeType?.includes("spreadsheetml")) return "xlsx";
	if (mimeType === "application/vnd.ms-excel") return "xls";

	return "bin";
}

function formatTrainingTimestamp(date = new Date()): string {
	const iso = date.toISOString().replace("T", "-").replace("Z", "");
	return iso.replace(/\..+$/, "").replace(/:/g, "-");
}

function isExcelAttachment(
	originalName?: string,
	mimeType?: string,
	data?: string,
): boolean {
	const ext = originalName ? path.extname(originalName).toLowerCase() : "";
	const type = mimeType || getMimeTypeFromData(data);
	return (type ? excelMimeTypes.has(type) : false) || (ext ? excelExtensions.has(ext) : false);
}

type TrainingFileViewData = {
	error: string;
	fileName: string;
	attachmentUrl: string;
	sheetName: string;
	header: string[];
	rows: string[][];
};

async function buildTrainingFileViewData(
	order: OrderDoc | null,
): Promise<TrainingFileViewData> {
	if (!order?.attachmentUrl) {
		return {
			error: "Файл не найден.",
			fileName: "",
			attachmentUrl: "",
			sheetName: "",
			header: [],
			rows: [],
		};
	}

	const storedName = path.basename(order.attachmentUrl);
	const filePath = path.join(uploadsDir, storedName);

	try {
		const buffer = await fs.readFile(filePath);
		const workbook = XLSX.read(buffer, { type: "buffer" });
		const sheetName = workbook.SheetNames[0];
		const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;

		if (!sheet) {
			return {
				error: "Лист Excel не найден.",
				fileName: order.attachmentFileName || storedName,
				attachmentUrl: order.attachmentUrl,
				sheetName: sheetName || "",
				header: [],
				rows: [],
			};
		}

		const rawRows = XLSX.utils.sheet_to_json(sheet, {
			header: 1,
			blankrows: false,
			defval: "",
		}) as Array<Array<unknown>>;

		const rows = rawRows.map((row) =>
			row.map((cell) => (cell === null || cell === undefined ? "" : String(cell))),
		);
		const maxColumns = rows.reduce((max, row) => Math.max(max, row.length), 0);
		const normalized = rows.map((row) => {
			if (row.length >= maxColumns) return row;
			return [...row, ...Array(maxColumns - row.length).fill("")];
		});
		const header = normalized.at(0) ?? [];
		const bodyRows = normalized.slice(1);

		return {
			error: "",
			fileName: order.attachmentFileName || storedName,
			attachmentUrl: order.attachmentUrl,
			sheetName: sheetName || "",
			header,
			rows: bodyRows,
		};
	} catch (error) {
		return {
			error: "Не удалось открыть файл.",
			fileName: order.attachmentFileName || storedName,
			attachmentUrl: order.attachmentUrl,
			sheetName: "",
			header: [],
			rows: [],
		};
	}
}

async function saveAttachment(
	data: string,
	originalName?: string,
	mimeTypeOverride?: string,
) {
	const parsed = parseDataUrl(data);
	const base64 = parsed.base64 ?? data;
	const mimeType =
		parsed.mimeType || mimeTypeOverride || "application/octet-stream";
	const normalizedBase64 = String(base64 ?? "").trim();
	const sanitized = normalizedBase64
		.replace(/\s+/g, "")
		.replace(/-/g, "+")
		.replace(/_/g, "/");
	const padded = sanitized.padEnd(
		Math.ceil(sanitized.length / 4) * 4,
		"=",
	);
	const buffer = Buffer.from(padded, "base64");

	if (!buffer.length) {
		throw new Error("Empty attachment");
	}

	if (buffer.length > MAX_ATTACHMENT_BYTES) {
		throw new Error("Attachment too large");
	}

	await fs.mkdir(uploadsDir, { recursive: true });
	const ext = detectExcelExtension(buffer, originalName, mimeType);
	const timestamp = formatTrainingTimestamp();
	const suffix = crypto.randomBytes(2).toString("hex");
	const storedName = `training-${timestamp}-${suffix}.${ext}`;
	const fullPath = path.join(uploadsDir, storedName);
	await fs.writeFile(fullPath, buffer);

	return {
		attachmentUrl: `/uploads/${storedName}`,
		attachmentFileName: originalName || storedName,
		attachmentMimeType: mimeType,
	};
}

async function removeAttachmentFile(attachmentUrl?: string) {
	if (!attachmentUrl) return;
	const storedName = path.basename(attachmentUrl);
	const filePath = path.join(uploadsDir, storedName);
	try {
		await fs.unlink(filePath);
	} catch (error) {
		// Ignore missing files.
	}
}

router.get("/health", (_req: Request, res: Response) => {
	res.status(200).json({ status: "OK", message: "API is healthy" });
});

router.get("/admin/main", (req: Request, res: Response) => {
	res.render("admin/main", {
		activePage: "main",
		adminTelegramId: resolveAdminTelegramId(req),
	});
});

router.get("/admin/requests", (req: Request, res: Response) => {
	res.render("admin/requests", {
		activePage: "requests",
		adminTelegramId: resolveAdminTelegramId(req),
	});
});

router.get("/admin/users", (req: Request, res: Response) => {
	res.render("admin/users", {
		activePage: "users",
		adminTelegramId: resolveAdminTelegramId(req),
	});
});

router.get("/admin/settings", (req: Request, res: Response) => {
	res.render("admin/settings", {
		activePage: "settings",
		adminTelegramId: resolveAdminTelegramId(req),
	});
});

router.get("/miniapp/main", (req: Request, res: Response) => {
	res.render("miniapp/main", {
		telegramId: resolveTelegramUserId(req),
	});
});

router.get("/miniapp/request", (req: Request, res: Response) => {
	res.render("miniapp/createOrder", {
		telegramId: resolveTelegramUserId(req),
	});
});

router.get("/api/admin/profile", async (req: Request, res: Response) => {
	try {
		const adminTelegramId = resolveAdminTelegramId(req);
		const query = adminTelegramId
			? { telegramId: adminTelegramId, isAdmin: true }
			: { isAdmin: true };
		const admin = await User.findOne(query)
			.select("telegramId firstName lastName username photoUrl")
			.lean<UserDoc | null>();

		if (!admin) {
			res.status(404).json({ message: "Admin not found" });
			return;
		}

		res.json({ admin });
	} catch (error) {
		await logAppError(
			error,
			withAdminContext(req, {
				source: "api",
				path: req.path,
				method: req.method,
				status: 500,
			}),
		);
		res.status(500).json({ message: "Failed to load profile" });
	}
});

router.get("/api/admin/summary", async (req: Request, res: Response) => {
	try {
		const adminTelegramId = resolveAdminTelegramId(req);
		const pending = await Order.countDocuments({ status: "pending" });
		const acceptedFilter = adminTelegramId
			? { status: "accepted", adminTelegramId }
			: { status: "accepted" };
		const accepted = await Order.countDocuments(acceptedFilter);
		const goals = await TrainingGoal.countDocuments({ isActive: true });

		res.json({ summary: { pending, accepted, goals } });
	} catch (error) {
		await logAppError(
			error,
			withAdminContext(req, {
				source: "api",
				path: req.path,
				method: req.method,
				status: 500,
			}),
		);
		res.status(500).json({ message: "Failed to load summary" });
	}
});

router.get("/api/admin/goals", async (_req: Request, res: Response) => {
	try {
		const goals = await TrainingGoal.find({ isActive: true })
			.sort({ sortOrder: 1, createdAt: 1 })
			.select("title")
			.lean();

		const items = goals.map((goal) => ({
			id: goal._id,
			title: goal.title,
		}));

		res.json({ items });
	} catch (error) {
		await logAppError(error, { source: "api", status: 500 });
		res.status(500).json({ message: "Failed to load goals" });
	}
});

router.post("/api/admin/goals", async (req: Request, res: Response) => {
	try {
		const body = req.body as Record<string, unknown>;
		const title = typeof body.title === "string" ? body.title.trim() : "";

		if (!title) {
			res.status(400).json({ message: "Title is required" });
			return;
		}

		const existing = await TrainingGoal.findOne({ title }).select("isActive");
		if (existing) {
			if (existing.isActive) {
				res.status(409).json({ message: "Goal already exists" });
				return;
			}
			existing.isActive = true;
			await existing.save();
			res.status(200).json({ id: existing._id, title });
			return;
		}

		const created = await TrainingGoal.create({ title, isActive: true });
		res.status(201).json({ id: created._id, title: created.title });
	} catch (error) {
		await logAppError(error, {
			source: "api",
			path: req.path,
			method: req.method,
			status: 500,
		});
		const code = (error as { code?: number } | null)?.code;
		if (code === 11000) {
			res.status(409).json({ message: "Goal already exists" });
			return;
		}
		res.status(500).json({ message: "Failed to create goal" });
	}
});

router.delete("/api/admin/goals/:id", async (req: Request, res: Response) => {
	try {
		const goalId = req.params.id;
		if (!goalId) {
			res.status(400).json({ message: "Goal id is required" });
			return;
		}

		const goal = await TrainingGoal.findById(goalId);
		if (!goal) {
			res.status(404).json({ message: "Goal not found" });
			return;
		}

		goal.isActive = false;
		await goal.save();

		res.status(204).send();
	} catch (error) {
		await logAppError(error, {
			source: "api",
			path: req.path,
			method: req.method,
			status: 500,
		});
		res.status(500).json({ message: "Failed to delete goal" });
	}
});

router.get("/api/admin/trainings", async (req: Request, res: Response) => {
	try {
		const adminTelegramId = resolveAdminTelegramId(req);
		const filter = adminTelegramId
			? { status: { $in: ["accepted", "completed"] }, adminTelegramId }
			: { status: { $in: ["accepted", "completed"] } };
		const orders = await Order.find(filter)
			.populate({ path: "goalId", select: "title" })
			.sort({ trainingDate: 1, createdAt: -1 })
			.lean<OrderDoc[]>();
		const telegramIds = orders.map((order) => order.telegramUserId);
		const users = await User.find({ telegramId: { $in: telegramIds } })
			.select("telegramId firstName lastName username photoUrl fullName phoneNumber")
			.lean<UserDoc[]>();
		const userById = new Map(users.map((user) => [user.telegramId, user]));

		const items = orders.map((order) => {
			const user = userById.get(order.telegramUserId);
			return {
			id: order._id,
			telegramUserId: order.telegramUserId,
			fullName: order.fullName || user?.fullName,
			phoneNumber: order.phoneNumber || user?.phoneNumber,
			status: order.status,
			trainingDate: order.trainingDate || order.createdAt,
			goalTitle: extractGoalTitle(order.goalId),
			attachmentUrl: order.attachmentUrl,
			attachmentFileName: order.attachmentFileName,
			user,
			};
		});

		res.json({ items });
	} catch (error) {
		await logAppError(
			error,
			withAdminContext(req, {
				source: "api",
				path: req.path,
				method: req.method,
				status: 500,
			}),
		);
		res.status(500).json({ message: "Failed to load trainings" });
	}
});

router.get("/api/admin/requests", async (_req: Request, res: Response) => {
	try {
		const orders = await Order.find({ status: "pending" })
			.populate({ path: "goalId", select: "title" })
			.sort({ createdAt: -1 })
			.lean<OrderDoc[]>();
		const telegramIds = orders.map((order) => order.telegramUserId);
		if (telegramIds.length) {
			await User.updateMany(
				{
					telegramId: { $in: telegramIds },
					isAdmin: { $ne: true },
					$or: [{ trainingStatus: { $exists: false } }, { trainingStatus: "none" }],
				},
				{ $set: { trainingStatus: "requested" } },
			);
		}
		const users = await User.find({ telegramId: { $in: telegramIds } })
			.select("telegramId firstName lastName username photoUrl fullName phoneNumber")
			.lean<UserDoc[]>();
		const userById = new Map(users.map((user) => [user.telegramId, user]));

		const items = orders.map((order) => {
			const user = userById.get(order.telegramUserId);
			return {
				id: order._id,
				fullName: order.fullName || user?.fullName,
				phoneNumber: order.phoneNumber || user?.phoneNumber,
				telegramUserId: order.telegramUserId,
				age: order.age,
				weightKg: order.weightKg,
				heightCm: order.heightCm,
				medicalContraindications: order.medicalContraindications,
				goalTitle: extractGoalTitle(order.goalId),
				firstName: user?.firstName,
				lastName: user?.lastName,
				username: user?.username,
				photoUrl: user?.photoUrl,
			};
		});

		res.json({ items });
	} catch (error) {
		await logAppError(error, { source: "api", status: 500 });
		res.status(500).json({ message: "Failed to load requests" });
	}
});

router.post("/api/admin/requests/:id/accept", async (req: Request, res: Response) => {
	try {
		const adminTelegramId = resolveAdminTelegramId(req);
		if (!adminTelegramId) {
			res.status(400).json({ message: "adminTelegramId is required" });
			return;
		}

		const body = req.body as Record<string, unknown>;
		const attachmentData =
			typeof body.attachmentData === "string" ? body.attachmentData : "";
		const attachmentName =
			typeof body.attachmentName === "string" ? body.attachmentName : undefined;
		const attachmentMimeType =
			typeof body.attachmentMimeType === "string"
				? body.attachmentMimeType
				: undefined;

		if (!attachmentData) {
			res.status(400).json({ message: "Excel file is required" });
			return;
		}

		if (!isExcelAttachment(attachmentName, attachmentMimeType, attachmentData)) {
			res.status(400).json({ message: "Only .xls or .xlsx files are allowed" });
			return;
		}

		const update: Record<string, unknown> = {
			status: "accepted",
			adminTelegramId,
			decisionAt: new Date(),
		};

		if (typeof body.trainingDate === "string" && body.trainingDate) {
			const date = new Date(body.trainingDate);
			if (!Number.isNaN(date.valueOf())) {
				update.trainingDate = date;
			}
		}

		const saved = await saveAttachment(
			attachmentData,
			attachmentName,
			attachmentMimeType,
		);
		Object.assign(update, saved);

		const updated = await Order.findOneAndUpdate(
			{ _id: req.params.id, status: "pending" },
			update,
			{ new: true },
		);

		if (!updated) {
			res.status(404).json({ message: "Request not found" });
			return;
		}

		await User.updateOne(
			{ telegramId: updated.telegramUserId },
			{ $set: { trainingStatus: "active" } },
		);

		res.json({ status: "accepted" });
	} catch (error) {
		await logAppError(
			error,
			withAdminContext(req, {
				source: "api",
				path: req.path,
				method: req.method,
				status: 500,
			}),
		);
		const message =
			error instanceof Error && error.message === "Attachment too large"
				? "Attachment too large"
				: "Failed to accept request";
		res.status(500).json({ message });
	}
});

router.post("/api/admin/requests/:id/decline", async (req: Request, res: Response) => {
	try {
		const adminTelegramId = resolveAdminTelegramId(req);
		if (!adminTelegramId) {
			res.status(400).json({ message: "adminTelegramId is required" });
			return;
		}

		const updated = await Order.findOneAndUpdate(
			{ _id: req.params.id, status: "pending" },
			{
				status: "declined",
				adminTelegramId,
				decisionAt: new Date(),
			},
			{ new: true },
		);

		if (!updated) {
			res.status(404).json({ message: "Request not found" });
			return;
		}

		await User.updateOne(
			{ telegramId: updated.telegramUserId },
			{ $set: { trainingStatus: "declined" } },
		);

		res.json({ status: "declined" });
	} catch (error) {
		await logAppError(
			error,
			withAdminContext(req, {
				source: "api",
				path: req.path,
				method: req.method,
				status: 500,
			}),
		);
		res.status(500).json({ message: "Failed to decline request" });
	}
});

router.post("/api/admin/trainings/:id/complete", async (req: Request, res: Response) => {
	try {
		const adminTelegramId = resolveAdminTelegramId(req);
		if (!adminTelegramId) {
			res.status(400).json({ message: "adminTelegramId is required" });
			return;
		}

		const updated = await Order.findOneAndUpdate(
			{ _id: req.params.id, status: "accepted" },
			{
				status: "completed",
				adminTelegramId,
				completedAt: new Date(),
			},
			{ new: true },
		);

		if (!updated) {
			res.status(404).json({ message: "Training not found" });
			return;
		}

		await User.updateOne(
			{ telegramId: updated.telegramUserId },
			{ $set: { trainingStatus: "completed" } },
		);

		res.json({ status: "completed" });
	} catch (error) {
		await logAppError(
			error,
			withAdminContext(req, {
				source: "api",
				path: req.path,
				method: req.method,
				status: 500,
			}),
		);
		res.status(500).json({ message: "Failed to complete training" });
	}
});

router.post("/api/admin/trainings/:id/delete", async (req: Request, res: Response) => {
	try {
		const adminTelegramId = resolveAdminTelegramId(req);
		if (!adminTelegramId) {
			res.status(400).json({ message: "adminTelegramId is required" });
			return;
		}

		const filter = {
			_id: req.params.id,
			$or: [
				{ adminTelegramId },
				{ adminTelegramId: { $exists: false } },
				{ adminTelegramId: null },
			],
		};
		const order = await Order.findOne(filter)
			.select("telegramUserId attachmentUrl status")
			.lean<OrderDoc | null>();

		if (!order) {
			res.status(404).json({ message: "Training not found" });
			return;
		}

		await Order.deleteOne({ _id: req.params.id });
		await removeAttachmentFile(order.attachmentUrl);

		const remaining = await Order.find({ telegramUserId: order.telegramUserId })
			.select("status")
			.lean<{ status: string }[]>();

		const nextStatus =
			remaining.find((item) => item.status === "accepted")?.status
				? "active"
				: remaining.find((item) => item.status === "pending")?.status
					? "requested"
					: remaining.find((item) => item.status === "completed")?.status
						? "completed"
						: remaining.find((item) => item.status === "declined")?.status
							? "declined"
							: "none";

		await User.updateOne(
			{ telegramId: order.telegramUserId },
			{ $set: { trainingStatus: nextStatus } },
		);

		res.json({ status: "deleted" });
	} catch (error) {
		await logAppError(
			error,
			withAdminContext(req, {
				source: "api",
				path: req.path,
				method: req.method,
				status: 500,
			}),
		);
		res.status(500).json({ message: "Failed to delete training" });
	}
});

router.get("/admin/trainings/:id/file", async (req: Request, res: Response) => {
	try {
		const adminTelegramId = resolveAdminTelegramId(req);
		const order = await Order.findById(req.params.id)
			.select("attachmentUrl attachmentFileName attachmentMimeType")
			.lean<OrderDoc | null>();
		const viewData = await buildTrainingFileViewData(order);
		const status = viewData.error ? 404 : 200;

		res.status(status).render("admin/training-file", {
			activePage: "",
			adminTelegramId,
			...viewData,
		});
	} catch (error) {
		await logAppError(
			error,
			withAdminContext(req, {
				source: "admin-view",
				path: req.path,
				method: req.method,
				status: 500,
			}),
		);
		res.status(500).render("admin/training-file", {
			activePage: "",
			adminTelegramId: resolveAdminTelegramId(req),
			error: "Не удалось открыть файл.",
			fileName: "",
			attachmentUrl: "",
			sheetName: "",
			header: [],
			rows: [],
		});
	}
});

router.get("/api/admin/users", async (_req: Request, res: Response) => {
	try {
		const users = await User.find()
			.select("telegramId firstName lastName username photoUrl isAdmin trainingStatus")
			.sort({ createdAt: -1 })
			.lean<UserDoc[]>();

		const items = users.map((user) => ({
			telegramId: user.telegramId,
			firstName: user.firstName,
			lastName: user.lastName,
			username: user.username,
			photoUrl: user.photoUrl,
			isAdmin: Boolean(user.isAdmin),
			status: user.isAdmin ? null : (user.trainingStatus ?? "none"),
		}));

		res.json({ items });
	} catch (error) {
		await logAppError(error, { source: "api", status: 500 });
		res.status(500).json({ message: "Failed to load users" });
	}
});

router.get("/miniapp/trainings/:id/file", async (req: Request, res: Response) => {
	try {
		const telegramId = resolveTelegramUserId(req);
		const order = await Order.findById(req.params.id)
			.select("telegramUserId attachmentUrl attachmentFileName attachmentMimeType")
			.lean<OrderDoc | null>();

		if (!order) {
			res.status(404).render("miniapp/training-file", {
				telegramId,
				...(await buildTrainingFileViewData(null)),
			});
			return;
		}

		if (telegramId && order.telegramUserId !== telegramId) {
			res.status(403).render("miniapp/training-file", {
				telegramId,
				error: "Нет доступа к этому файлу.",
				fileName: "",
				attachmentUrl: "",
				sheetName: "",
				header: [],
				rows: [],
			});
			return;
		}

		const viewData = await buildTrainingFileViewData(order);
		const status = viewData.error ? 404 : 200;

		res.status(status).render("miniapp/training-file", {
			telegramId,
			...viewData,
		});
	} catch (error) {
		await logAppError(error, {
			source: "miniapp-view",
			path: req.path,
			method: req.method,
			status: 500,
		});
		res.status(500).render("miniapp/training-file", {
			telegramId: resolveTelegramUserId(req),
			error: "Не удалось открыть файл.",
			fileName: "",
			attachmentUrl: "",
			sheetName: "",
			header: [],
			rows: [],
		});
	}
});

router.get("/api/miniapp/profile", async (req: Request, res: Response) => {
	try {
		const telegramId = resolveTelegramUserId(req);
		if (!telegramId) {
			res.status(400).json({ message: "telegramId is required" });
			return;
		}

		const user = await User.findOne({ telegramId })
			.select("telegramId firstName lastName username photoUrl trainingStatus isAdmin")
			.lean<UserDoc | null>();

		if (!user) {
			res.status(404).json({ message: "User not found" });
			return;
		}

		res.json({
			user: {
				telegramId: user.telegramId,
				firstName: user.firstName,
				lastName: user.lastName,
				username: user.username,
				photoUrl: user.photoUrl,
				trainingStatus: user.trainingStatus ?? "none",
				isAdmin: Boolean(user.isAdmin),
			},
		});
	} catch (error) {
		await logAppError(error, {
			source: "api",
			path: req.path,
			method: req.method,
			status: 500,
		});
		res.status(500).json({ message: "Failed to load profile" });
	}
});

router.get("/api/miniapp/goals", async (_req: Request, res: Response) => {
	try {
		const goals = await TrainingGoal.find({ isActive: true })
			.sort({ sortOrder: 1, createdAt: 1 })
			.select("title")
			.lean();

		res.json({ items: goals });
	} catch (error) {
		await logAppError(error, { source: "api", status: 500 });
		res.status(500).json({ message: "Failed to load goals" });
	}
});

router.get("/api/miniapp/orders", async (req: Request, res: Response) => {
	try {
		const telegramId = resolveTelegramUserId(req);
		if (!telegramId) {
			res.status(400).json({ message: "telegramId is required" });
			return;
		}

		const user = await User.findOne({ telegramId })
			.select("trainingStatus isAdmin")
			.lean<UserDoc | null>();

		if (!user) {
			res.status(404).json({ message: "User not found" });
			return;
		}

		const orders = await Order.find({ telegramUserId: telegramId })
			.populate({ path: "goalId", select: "title" })
			.sort({ createdAt: -1 })
			.lean<OrderDoc[]>();

		const items = orders.map((order) => ({
			id: order._id,
			status: order.status,
			trainingDate: order.trainingDate || order.createdAt,
			goalTitle: extractGoalTitle(order.goalId),
			attachmentUrl: order.attachmentUrl,
			attachmentFileName: order.attachmentFileName,
		}));

		res.json({
			items,
			trainingStatus: user.trainingStatus ?? "none",
			isAdmin: Boolean(user.isAdmin),
		});
	} catch (error) {
		await logAppError(error, {
			source: "api",
			path: req.path,
			method: req.method,
			status: 500,
		});
		res.status(500).json({ message: "Failed to load orders" });
	}
});

router.post("/api/miniapp/orders", async (req: Request, res: Response) => {
	try {
		const telegramId = resolveTelegramUserId(req);
		if (!telegramId) {
			res.status(400).json({ message: "telegramId is required" });
			return;
		}

		const user = await User.findOne({ telegramId })
			.select("isAdmin trainingStatus")
			.lean<UserDoc | null>();

		if (!user) {
			res.status(404).json({ message: "User not found" });
			return;
		}

		if (user.isAdmin) {
			res.status(403).json({ message: "Admins cannot create requests" });
			return;
		}

		if (user.trainingStatus === "active" || user.trainingStatus === "requested") {
			res.status(409).json({ message: "User already has an open request" });
			return;
		}

		const body = req.body as Record<string, unknown>;
		const fullName =
			typeof body.fullName === "string" ? body.fullName.trim() : "";
		if (!fullName) {
			res.status(400).json({ message: "Name is required" });
			return;
		}

		const phoneNumber =
			typeof body.phoneNumber === "string" ? body.phoneNumber.trim() : "";
		const phoneDigits = phoneNumber.replace(/\D/g, "");
		if (!phoneNumber || phoneDigits.length < 6 || phoneDigits.length > 15) {
			res.status(400).json({ message: "Valid phone number is required" });
			return;
		}

		const goalId = typeof body.goalId === "string" ? body.goalId : "";
		const goal = await TrainingGoal.findOne({ _id: goalId, isActive: true })
			.select("_id")
			.lean();

		if (!goal) {
			res.status(400).json({ message: "Training goal is required" });
			return;
		}

		const gender = typeof body.gender === "string" ? body.gender : undefined;
		if (gender && !["male", "female", "other"].includes(gender)) {
			res.status(400).json({ message: "Invalid gender value" });
			return;
		}

		let age: number | undefined;
		if (typeof body.age === "number") {
			age = body.age;
		} else if (typeof body.age === "string" && body.age.trim()) {
			const parsed = Number(body.age);
			if (Number.isFinite(parsed)) {
				age = parsed;
			}
		}
		if (age === undefined || age < 1 || age > 120) {
			res.status(400).json({ message: "Valid age is required" });
			return;
		}

		let heightCm: number | undefined;
		if (typeof body.heightCm === "number") {
			heightCm = body.heightCm;
		} else if (typeof body.heightCm === "string" && body.heightCm.trim()) {
			const parsed = Number(body.heightCm);
			if (Number.isFinite(parsed)) {
				heightCm = parsed;
			}
		}
		if (heightCm === undefined || heightCm < 50 || heightCm > 250) {
			res.status(400).json({ message: "Valid height is required" });
			return;
		}

		let weightKg: number | undefined;
		if (typeof body.weightKg === "number") {
			weightKg = body.weightKg;
		} else if (typeof body.weightKg === "string" && body.weightKg.trim()) {
			const parsed = Number(body.weightKg);
			if (Number.isFinite(parsed)) {
				weightKg = parsed;
			}
		}
		if (weightKg === undefined || weightKg < 20 || weightKg > 300) {
			res.status(400).json({ message: "Valid weight is required" });
			return;
		}

		const medicalContraindications =
			typeof body.medicalContraindications === "string"
				? body.medicalContraindications
				: undefined;

		const orderPayload: {
			fullName: string;
			phoneNumber: string;
			telegramUserId: number;
			goalId: string;
			status: "pending";
			gender?: string;
			age?: number;
			weightKg?: number;
			heightCm?: number;
			medicalContraindications?: string;
		} = {
			fullName,
			phoneNumber,
			telegramUserId: telegramId,
			goalId,
			status: "pending",
			...(gender ? { gender } : {}),
			...(age === undefined ? {} : { age }),
			...(weightKg === undefined ? {} : { weightKg }),
			...(heightCm === undefined ? {} : { heightCm }),
			...(medicalContraindications ? { medicalContraindications } : {}),
		};

		const order = (await Order.create(orderPayload)) as {
			_id: { toString(): string };
		};

		await User.updateOne(
			{ telegramId },
			{
				$set: {
					trainingStatus: "requested",
					fullName,
					phoneNumber,
				},
			},
		);

		res.status(201).json({ id: order._id.toString() });
	} catch (error) {
		await logAppError(error, {
			source: "api",
			path: req.path,
			method: req.method,
			status: 500,
		});
		res.status(500).json({ message: "Failed to create order" });
	}
});

router.get("/admin/errors", (req: Request, res: Response) => {
	res.render("admin/errors", {
		activePage: "errors",
		adminTelegramId: resolveAdminTelegramId(req),
	});
});

router.get("/api/admin/errors", async (req: Request, res: Response) => {
	try {
		const items = await AppError.find()
			.sort({ createdAt: -1 })
			.limit(100)
			.lean();
		res.json({ items });
	} catch (error) {
		await logAppError(error, {
			source: "api",
			path: req.path,
			method: req.method,
			status: 500,
		});
		res.status(500).json({ message: "Failed to load errors" });
	}
});

export default router;
