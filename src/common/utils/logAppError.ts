import AppError from "../models/AppError.js";

type LogContext = {
	source: string;
	path?: string;
	method?: string;
	status?: number;
	adminTelegramId?: number;
};

export async function logAppError(
	error: unknown,
	context: LogContext,
): Promise<void> {
	const message = error instanceof Error ? error.message : String(error);
	const stack = error instanceof Error ? error.stack : undefined;

	try {
		const payload: {
			source: string;
			message: string;
			stack?: string;
			path?: string;
			method?: string;
			status?: number;
			adminTelegramId?: number;
		} = {
			source: context.source,
			message,
		};

		if (stack) payload.stack = stack;
		if (context.path) payload.path = context.path;
		if (context.method) payload.method = context.method;
		if (context.status !== undefined) payload.status = context.status;
		if (context.adminTelegramId !== undefined) {
			payload.adminTelegramId = context.adminTelegramId;
		}

		await AppError.create(payload);

		const total = await AppError.countDocuments();
		if (total > 500) {
			const extra = total - 500;
			const oldIds = await AppError.find()
				.sort({ createdAt: 1 })
				.limit(extra)
				.select("_id")
				.lean<{ _id: string }[]>();
			if (oldIds.length) {
				await AppError.deleteMany({ _id: { $in: oldIds.map((item) => item._id) } });
			}
		}
	} catch {
		// Avoid recursive logging failures.
	}
}
