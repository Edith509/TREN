import express from "express";
import type { Request, Response } from "express";

import AppError from "../models/AppError.js";
import NutritionOrder from "../models/NutritionOrders.js";
import Order from "../models/Orders.js";
import TrainingGoal from "../models/TrainingGoal.js";
import User from "../models/User.js";
import { logAppError } from "../utils/logAppError.js";
import {
	buildTrainingFileViewData,
	extractGoalTitle,
	isExcelAttachment,
	removeAttachmentFile,
	resolveAdminTelegramId,
	saveAttachment,
	withAdminContext,
	type NutritionOrderDoc,
	type OrderDoc,
	type UserDoc,
} from "./utils.js";

const router = express.Router();

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

router.get("/admin/errors", (req: Request, res: Response) => {
	res.render("admin/errors", {
		activePage: "errors",
		adminTelegramId: resolveAdminTelegramId(req),
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
		const pendingTraining = await Order.countDocuments({ status: "pending" });
		const acceptedFilter = adminTelegramId
			? { status: "accepted", adminTelegramId }
			: { status: "accepted" };
		const accepted = await Order.countDocuments(acceptedFilter);
		const pendingNutrition = await NutritionOrder.countDocuments({ status: "pending" });
		const nutritionAcceptedFilter = adminTelegramId
			? { status: "accepted", adminTelegramId }
			: { status: "accepted" };
		const nutritionAccepted = await NutritionOrder.countDocuments(
			nutritionAcceptedFilter,
		);
		const goals = await TrainingGoal.countDocuments({ isActive: true });

		res.json({
			summary: {
				pendingTraining,
				accepted,
				pendingNutrition,
				nutritionAccepted,
				goals,
			},
		});
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

router.get("/api/admin/nutrition/plans", async (req: Request, res: Response) => {
	try {
		const adminTelegramId = resolveAdminTelegramId(req);
		const filter = adminTelegramId
			? { status: { $in: ["accepted", "completed"] }, adminTelegramId }
			: { status: { $in: ["accepted", "completed"] } };
		const orders = await NutritionOrder.find(filter)
			.sort({ createdAt: -1 })
			.lean<NutritionOrderDoc[]>();
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
				createdAt: order.createdAt,
				nutritionGoal: order.nutritionGoal,
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
		res.status(500).json({ message: "Failed to load nutrition plans" });
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

router.get("/api/admin/nutrition/requests", async (_req: Request, res: Response) => {
	try {
		const orders = await NutritionOrder.find({ status: "pending" })
			.sort({ createdAt: -1 })
			.lean<NutritionOrderDoc[]>();
		const telegramIds = orders.map((order) => order.telegramUserId);
		if (telegramIds.length) {
			await User.updateMany(
				{
					telegramId: { $in: telegramIds },
					isAdmin: { $ne: true },
					$or: [
						{ nutritionStatus: { $exists: false } },
						{ nutritionStatus: "none" },
					],
				},
				{ $set: { nutritionStatus: "requested" } },
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
				nutritionGoal: order.nutritionGoal,
				firstName: user?.firstName,
				lastName: user?.lastName,
				username: user?.username,
				photoUrl: user?.photoUrl,
			};
		});

		res.json({ items });
	} catch (error) {
		await logAppError(error, { source: "api", status: 500 });
		res.status(500).json({ message: "Failed to load nutrition requests" });
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

router.post("/api/admin/nutrition/requests/:id/accept", async (req: Request, res: Response) => {
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

		const saved = await saveAttachment(
			attachmentData,
			attachmentName,
			attachmentMimeType,
		);

		const updated = await NutritionOrder.findOneAndUpdate(
			{ _id: req.params.id, status: "pending" },
			{
				status: "accepted",
				adminTelegramId,
				decisionAt: new Date(),
				...saved,
			},
			{ new: true },
		);

		if (!updated) {
			res.status(404).json({ message: "Request not found" });
			return;
		}

		await User.updateOne(
			{ telegramId: updated.telegramUserId },
			{ $set: { nutritionStatus: "active" } },
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

router.post("/api/admin/nutrition/requests/:id/decline", async (req: Request, res: Response) => {
	try {
		const adminTelegramId = resolveAdminTelegramId(req);
		if (!adminTelegramId) {
			res.status(400).json({ message: "adminTelegramId is required" });
			return;
		}

		const updated = await NutritionOrder.findOneAndUpdate(
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
			{ $set: { nutritionStatus: "declined" } },
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

router.post("/api/admin/nutrition/plans/:id/complete", async (req: Request, res: Response) => {
	try {
		const adminTelegramId = resolveAdminTelegramId(req);
		if (!adminTelegramId) {
			res.status(400).json({ message: "adminTelegramId is required" });
			return;
		}

		const updated = await NutritionOrder.findOneAndUpdate(
			{ _id: req.params.id, status: "accepted" },
			{
				status: "completed",
				adminTelegramId,
				completedAt: new Date(),
			},
			{ new: true },
		);

		if (!updated) {
			res.status(404).json({ message: "Plan not found" });
			return;
		}

		await User.updateOne(
			{ telegramId: updated.telegramUserId },
			{ $set: { nutritionStatus: "completed" } },
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
		res.status(500).json({ message: "Failed to complete nutrition plan" });
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

router.post("/api/admin/nutrition/plans/:id/delete", async (req: Request, res: Response) => {
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
		const order = await NutritionOrder.findOne(filter)
			.select("telegramUserId attachmentUrl status")
			.lean<NutritionOrderDoc | null>();

		if (!order) {
			res.status(404).json({ message: "Plan not found" });
			return;
		}

		await NutritionOrder.deleteOne({ _id: req.params.id });
		await removeAttachmentFile(order.attachmentUrl);

		const remaining = await NutritionOrder.find({
			telegramUserId: order.telegramUserId,
		})
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
			{ $set: { nutritionStatus: nextStatus } },
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
		res.status(500).json({ message: "Failed to delete nutrition plan" });
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

router.get("/admin/nutrition/:id/file", async (req: Request, res: Response) => {
	try {
		const adminTelegramId = resolveAdminTelegramId(req);
		const order = await NutritionOrder.findById(req.params.id)
			.select("attachmentUrl attachmentFileName attachmentMimeType")
			.lean<NutritionOrderDoc | null>();
		const viewData = await buildTrainingFileViewData(order);
		const status = viewData.error ? 404 : 200;

		res.status(status).render("admin/nutrition-file", {
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
		res.status(500).render("admin/nutrition-file", {
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

router.post("/api/admin/users/refresh", async (req: Request, res: Response) => {
	try {
		const adminTelegramId = resolveAdminTelegramId(req);
		if (!adminTelegramId) {
			res.status(400).json({ message: "adminTelegramId is required" });
			return;
		}

		const admin = await User.findOne({ telegramId: adminTelegramId, isAdmin: true })
			.select("_id")
			.lean();
		if (!admin) {
			res.status(403).json({ message: "Not authorized" });
			return;
		}

		const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
		if (!botToken) {
			res.status(500).json({ message: "Bot token not configured" });
			return;
		}

		const users = await User.find({ isBot: { $ne: true } })
			.select("telegramId")
			.lean<{ telegramId?: number }[]>();

		const fetchChat = async (telegramId: number) => {
			const res = await fetch(
				`https://api.telegram.org/bot${botToken}/getChat?chat_id=${telegramId}`,
			);
			if (!res.ok) return null;
			return (await res.json()) as {
				ok?: boolean;
				result?: {
					id?: number;
					first_name?: string;
					last_name?: string;
					username?: string;
					photo?: { big_file_id?: string };
				};
			};
		};

		const fetchFilePath = async (fileId: string) => {
			const res = await fetch(
				`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(
					fileId,
				)}`,
			);
			if (!res.ok) return null;
			const data = (await res.json()) as {
				ok?: boolean;
				result?: { file_path?: string };
			};
			return data.ok ? data.result?.file_path ?? null : null;
		};

		let updatedCount = 0;
		let failedCount = 0;

		for (const user of users) {
			const telegramId = user.telegramId;
			if (!telegramId) continue;
			try {
				const chat = await fetchChat(telegramId);
				if (!chat?.ok || !chat.result) {
					failedCount += 1;
					continue;
				}

				const updates: Record<string, unknown> = {
					chatId: chat.result.id ?? telegramId,
				};

				if (typeof chat.result.first_name === "string") {
					updates.firstName = chat.result.first_name;
				}
				if (typeof chat.result.last_name === "string") {
					updates.lastName = chat.result.last_name;
				}
				if (typeof chat.result.username === "string") {
					updates.username = chat.result.username;
				}

				const bigFileId = chat.result.photo?.big_file_id;
				if (bigFileId) {
					updates.photoFileId = bigFileId;
					const filePath = await fetchFilePath(bigFileId);
					if (filePath) {
						updates.photoUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
					}
				}

				await User.updateOne({ telegramId }, { $set: updates });
				updatedCount += 1;
			} catch {
				failedCount += 1;
			}
		}

		res.json({
			processed: users.length,
			updated: updatedCount,
			failed: failedCount,
		});
	} catch (error) {
		await logAppError(error, {
			source: "api",
			path: req.path,
			method: req.method,
			status: 500,
		});
		res.status(500).json({ message: "Failed to refresh users" });
	}
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
