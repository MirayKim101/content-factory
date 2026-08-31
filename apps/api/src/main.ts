import "reflect-metadata";

import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module.js";

const app = await NestFactory.create(AppModule);

app.enableCors({ origin: "http://localhost:3000" });
await app.listen(Number(process.env.PORT ?? 3001), "127.0.0.1");
