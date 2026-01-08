import mongoose from "mongoose";
import type { InferSchemaType } from "mongoose";

const { Schema, model, models } = mongoose;

const trainingGoalSchema = new Schema(
	{
		title: { type: String, required: true, trim: true, unique: true },
		isActive: { type: Boolean, default: true },
		sortOrder: { type: Number, default: 0 },
	},
	{ timestamps: true, versionKey: false },
);

export type TrainingGoalDocument = InferSchemaType<typeof trainingGoalSchema>;

const TrainingGoal =
	(models.TrainingGoal as mongoose.Model<TrainingGoalDocument> | undefined) ??
	model<TrainingGoalDocument>("TrainingGoal", trainingGoalSchema);

export default TrainingGoal;
