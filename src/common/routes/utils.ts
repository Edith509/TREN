import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { Request } from "express";
import * as XLSX from "xlsx";

const uploadsDir = path.resolve("public", "uploads");
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const excelMimeTypes = new Set([
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const excelExtensions = new Set([".xls", ".xlsx"]);
const OLE_HEADER = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export type OrderDoc = {
	_id: string;
	fullName?: string;
	phoneNumber?: string;
	telegramUserId: number;
	adminTelegramId?: number;
	status: string;
	trainingDate?: Date;
	goalId?: { title?: string } | null;
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

export type NutritionOrderDoc = {
	_id: string;
	fullName?: string;
	phoneNumber?: string;
	telegramUserId: number;
	adminTelegramId?: number;
	status: string;
	nutritionGoal?: string;
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

export type UserDoc = {
	telegramId: number;
	firstName?: string;
	lastName?: string;
	username?: string;
	photoUrl?: string;
	fullName?: string;
	phoneNumber?: string;
	isAdmin?: boolean;
	trainingStatus?: string;
	nutritionStatus?: string;
};

type TelegramInitUser = {
	id: number;
	first_name?: string;
	last_name?: string;
	username?: string;
	photo_url?: string;
	language_code?: string;
};

export function parseTelegramId(value: unknown): number | null {
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

export function resolveAdminTelegramId(req: Request): number | null {
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

export function resolveTelegramUserId(req: Request): number | null {
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

export function extractGoalTitle(goal?: { title?: string } | null): string | undefined {
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

export function isExcelAttachment(
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

export async function buildTrainingFileViewData(
	order: { attachmentUrl?: string; attachmentFileName?: string } | null,
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
	} catch {
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

export async function saveAttachment(
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

export async function removeAttachmentFile(attachmentUrl?: string) {
	if (!attachmentUrl) return;
	const storedName = path.basename(attachmentUrl);
	const filePath = path.join(uploadsDir, storedName);
	try {
		await fs.unlink(filePath);
	} catch {
		// Ignore missing files.
	}
}

export function withAdminContext(
	req: Request,
	base: { source: string; path?: string; method?: string; status?: number },
) {
	const adminTelegramId = resolveAdminTelegramId(req);
	return adminTelegramId ? { ...base, adminTelegramId } : base;
}
