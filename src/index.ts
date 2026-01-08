import path from "node:path";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
import engine from "ejs-mate";
import express from "express";
import mongoose from "mongoose";

import router from "./common/routes/router.js";
import { startBot } from "./telegram/bot.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const uri = process.env.MONGO_URI || "";
if (!uri) {
	process.exit(1);
}

async function connectToDatabase() {
	try {
		await mongoose.connect(uri, {
			dbName: "main",
		});
	} catch (err) {
		console.log(`Database connection error: ${err}`);
		throw err;
	}
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.resolve("public")));
app.use("/", router);
app.engine("ejs", engine);
app.set("view engine", "ejs");
app.set("views", path.resolve("views"));

app.get("/", (_req, res) => {
	res.send("Welcome to the ...");
});

// async function bootstrap() {
// 	await connectToDatabase();
// 	await startBot();
// 	app.listen(PORT, () => {
// 		console.log(`Server is running on port ${PORT}`);
// 	});
// }

// bootstrap().catch((error) => {
// 	console.log(`Error: ${error}`);
// 	process.exit(1);
// });

await connectToDatabase();
app.listen(PORT, async () => {
	await startBot();
	console.log(`Server is running on port ${PORT}`);
});
