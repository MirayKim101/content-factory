import "reflect-metadata";

import { pathToFileURL } from "node:url";

import {
  BadRequestException,
  ValidationPipe,
  type INestApplication,
} from "@nestjs/common";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

import { AppModule } from "./app.module.js";
import { loadEnvironment } from "./config/environment.js";
import { HttpExceptionFilter } from "./http-exception.filter.js";

loadEnvironment();

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: "http://localhost:3000" });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: false,
      stopAtFirstError: true,
      exceptionFactory: (errors) =>
        new BadRequestException({
          code: "VALIDATION_FAILED",
          message: `Invalid fields: ${errors.map((error) => error.property).join(", ")}.`,
        }),
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));

  const openApiConfig = new DocumentBuilder()
    .setTitle("Content Factory API")
    .setDescription("Private Content Factory REST API")
    .setVersion("1.0")
    .build();
  const document = SwaggerModule.createDocument(app, openApiConfig);
  SwaggerModule.setup("api/docs", app, document, {
    jsonDocumentUrl: "api/docs-json",
  });
  return app;
}

async function bootstrap(): Promise<void> {
  const app = await createApp();
  await app.listen(Number(process.env.PORT ?? 3001), "127.0.0.1");
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await bootstrap();
}
