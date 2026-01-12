import express from "express";
import type { Request, Response } from "express";

import NutritionOrder from "../models/NutritionOrders.js";
import Order from "../models/Orders.js";
import TrainingGoal from "../models/TrainingGoal.js";
import User from "../models/User.js";
import { logAppError } from "../utils/logAppError.js";
import {
	buildTrainingFileViewData,
	extractGoalTitle,
	resolveTelegramUserId,
	type NutritionOrderDoc,
	type OrderDoc,
	type UserDoc,
} from "./utils.js";

const router = express.Router();

router.get("/miniapp/main", (req: Request, res: Response) => {
	res.render("miniapp/main", {
		telegramId: resolveTelegramUserId(req),
		headerSubtitle: "Тренировки",
	});
});

router.get("/miniapp/request", (req: Request, res: Response) => {
	res.render("miniapp/createOrder", {
		telegramId: resolveTelegramUserId(req),
		headerSubtitle: "Тренировки",
	});
});

router.get("/miniapp/nutrition/request", (req: Request, res: Response) => {
	res.render("miniapp/createNutritionOrder", {
		telegramId: resolveTelegramUserId(req),
		headerSubtitle: "Питание",
	});
});

router.get("/miniapp/courses", (req: Request, res: Response) => {
	res.render("miniapp/courses", {
		telegramId: resolveTelegramUserId(req),
		headerSubtitle: "Курсы",
		showHomeButton: true,
	});
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

router.get("/miniapp/nutrition/:id/file", async (req: Request, res: Response) => {
	try {
		const telegramId = resolveTelegramUserId(req);
		const order = await NutritionOrder.findById(req.params.id)
			.select("telegramUserId attachmentUrl attachmentFileName attachmentMimeType")
			.lean<NutritionOrderDoc | null>();

		if (!order) {
			res.status(404).render("miniapp/nutrition-file", {
				telegramId,
				...(await buildTrainingFileViewData(null)),
			});
			return;
		}

		if (telegramId && order.telegramUserId !== telegramId) {
			res.status(403).render("miniapp/nutrition-file", {
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

		res.status(status).render("miniapp/nutrition-file", {
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
		res.status(500).render("miniapp/nutrition-file", {
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
			.select("telegramId firstName lastName username photoUrl trainingStatus nutritionStatus isAdmin")
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
				nutritionStatus: user.nutritionStatus ?? "none",
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

router.get("/api/miniapp/nutrition/orders", async (req: Request, res: Response) => {
	try {
		const telegramId = resolveTelegramUserId(req);
		if (!telegramId) {
			res.status(400).json({ message: "telegramId is required" });
			return;
		}

		const user = await User.findOne({ telegramId })
			.select("nutritionStatus isAdmin")
			.lean<UserDoc | null>();

		if (!user) {
			res.status(404).json({ message: "User not found" });
			return;
		}

		const orders = await NutritionOrder.find({ telegramUserId: telegramId })
			.sort({ createdAt: -1 })
			.lean<NutritionOrderDoc[]>();

		const items = orders.map((order) => ({
			id: order._id,
			status: order.status,
			createdAt: order.createdAt,
			nutritionGoal: order.nutritionGoal,
			attachmentUrl: order.attachmentUrl,
			attachmentFileName: order.attachmentFileName,
		}));

		res.json({
			items,
			nutritionStatus: user.nutritionStatus ?? "none",
			isAdmin: Boolean(user.isAdmin),
		});
	} catch (error) {
		await logAppError(error, {
			source: "api",
			path: req.path,
			method: req.method,
			status: 500,
		});
		res.status(500).json({ message: "Failed to load nutrition orders" });
	}
});

router.post("/api/miniapp/nutrition/orders", async (req: Request, res: Response) => {
	try {
		const telegramId = resolveTelegramUserId(req);
		if (!telegramId) {
			res.status(400).json({ message: "telegramId is required" });
			return;
		}

		const user = await User.findOne({ telegramId })
			.select("isAdmin nutritionStatus")
			.lean<UserDoc | null>();

		if (!user) {
			res.status(404).json({ message: "User not found" });
			return;
		}

		if (user.isAdmin) {
			res.status(403).json({ message: "Admins cannot create requests" });
			return;
		}

		if (user.nutritionStatus === "active" || user.nutritionStatus === "requested") {
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

		const nutritionGoal =
			typeof body.nutritionGoal === "string" ? body.nutritionGoal : "";
		if (!["loss", "mass", "quality"].includes(nutritionGoal)) {
			res.status(400).json({ message: "Nutrition goal is required" });
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
			nutritionGoal: string;
			status: "pending";
			age?: number;
			weightKg?: number;
			heightCm?: number;
			medicalContraindications?: string;
		} = {
			fullName,
			phoneNumber,
			telegramUserId: telegramId,
			nutritionGoal,
			status: "pending",
			...(age === undefined ? {} : { age }),
			...(weightKg === undefined ? {} : { weightKg }),
			...(heightCm === undefined ? {} : { heightCm }),
			...(medicalContraindications ? { medicalContraindications } : {}),
		};

		const order = (await NutritionOrder.create(orderPayload)) as {
			_id: { toString(): string };
		};

		await User.updateOne(
			{ telegramId },
			{
				$set: {
					nutritionStatus: "requested",
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
		res.status(500).json({ message: "Failed to create nutrition order" });
	}
});

export default router;
