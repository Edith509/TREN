import mongoose from "mongoose";
import type { InferSchemaType } from "mongoose";

const { Schema, model, models } = mongoose;

const appErrorSchema = new Schema(
	{
		source: { type: String, required: true, trim: true },
		message: { type: String, required: true, trim: true },
		stack: { type: String },
		path: { type: String, trim: true },
		method: { type: String, trim: true },
		status: { type: Number },
		adminTelegramId: { type: Number },
	},
	{ timestamps: true, versionKey: false },
);

export type AppErrorDocument = InferSchemaType<typeof appErrorSchema>;

const AppError =
	(models.AppError as mongoose.Model<AppErrorDocument> | undefined) ??
	model<AppErrorDocument>("AppError", appErrorSchema);

export default AppError;
