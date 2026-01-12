import mongoose from "mongoose";
import type { InferSchemaType } from "mongoose";

const { Schema, model, models } = mongoose;

const nutritionOrderSchema = new Schema(
	{
		fullName: { type: String, required: true, trim: true },
		phoneNumber: { type: String, required: true, trim: true },
		telegramUserId: { type: Number, required: true, index: true },
		adminTelegramId: { type: Number, index: true },
		age: { type: Number, min: 1, max: 120 },
		weightKg: { type: Number, min: 20, max: 300 },
		heightCm: { type: Number, min: 50, max: 250 },
		medicalContraindications: { type: String, trim: true },
		nutritionGoal: {
			type: String,
			enum: ["loss", "mass", "quality"],
			required: true,
		},
		attachmentUrl: { type: String, trim: true },
		attachmentFileName: { type: String, trim: true },
		attachmentMimeType: { type: String, trim: true },
		decisionAt: { type: Date },
		completedAt: { type: Date },
		status: {
			type: String,
			enum: ["pending", "accepted", "declined", "completed"],
			default: "pending",
		},
		notes: { type: String, trim: true },
	},
	{ timestamps: true, versionKey: false },
);

export type NutritionOrderDocument = InferSchemaType<typeof nutritionOrderSchema>;

const NutritionOrder =
	(models.NutritionOrder as mongoose.Model<NutritionOrderDocument> | undefined) ??
	model<NutritionOrderDocument>("NutritionOrder", nutritionOrderSchema);

export default NutritionOrder;
