import mongoose from "mongoose";
import type { InferSchemaType } from "mongoose";

const { Schema, model, models } = mongoose;

const userSchema = new Schema(
	{
		telegramId: { type: Number, required: true, unique: true, index: true },
		chatId: { type: Number, index: true },
		isBot: { type: Boolean, default: false },
		firstName: { type: String, required: true, trim: true },
		lastName: { type: String, trim: true },
		username: { type: String, trim: true },
		languageCode: { type: String, trim: true },
		fullName: { type: String, trim: true },
		phoneNumber: { type: String, trim: true },
		photoFileId: { type: String },
		photoUniqueId: { type: String },
		photoUrl: { type: String },
		isAdmin: { type: Boolean, default: false },
		trainingStatus: {
			type: String,
			enum: ["none", "requested", "active", "completed", "declined"],
			default: "none",
		},
		lastSeenAt: { type: Date },
	},
	{ timestamps: true, versionKey: false },
);

export type UserDocument = InferSchemaType<typeof userSchema>;

const User =
	(models.User as mongoose.Model<UserDocument> | undefined) ??
	model<UserDocument>("User", userSchema);

export default User;
