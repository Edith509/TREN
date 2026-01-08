import mongoose from "mongoose";
import type { InferSchemaType } from "mongoose";

const { Schema, model, models } = mongoose;

const broadcastSchema = new Schema(
	{
		adminTelegramId: { type: Number, required: true, index: true },
		text: { type: String, required: true, trim: true },
		photoFileIds: { type: [String], required: true },
		totalRecipients: { type: Number, required: true },
		successCount: { type: Number, required: true },
		failedCount: { type: Number, required: true },
	},
	{ timestamps: true, versionKey: false },
);

export type BroadcastDocument = InferSchemaType<typeof broadcastSchema>;

const Broadcast =
	(models.Broadcast as mongoose.Model<BroadcastDocument> | undefined) ??
	model<BroadcastDocument>("Broadcast", broadcastSchema);

export default Broadcast;
