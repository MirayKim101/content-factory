import "reflect-metadata";

import { pathToFileURL } from "node:url";

import {
  BadRequestException,
  ValidationPipe,
  type INestApplication,
} from "@nestjs/common";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from "@nestjs/swagger";

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

  const document = createOpenApiDocument(app);
  SwaggerModule.setup("api/docs", app, document, {
    jsonDocumentUrl: "api/docs-json",
  });
  return app;
}

/**
 * Builds the authoritative API contract from the same Nest application that
 * serves requests. Keeping this separate from HTTP listening lets contract
 * tooling export the schema without reserving a port or starting a watcher.
 */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const openApiConfig = new DocumentBuilder()
    .setTitle("Content Factory API")
    .setDescription("Private Content Factory REST API")
    .setVersion("1.0")
    .build();
  return SwaggerModule.createDocument(app, openApiConfig);
}

async function bootstrap(): Promise<void> {
  const app = await createApp();
  await app.listen(Number(process.env.PORT ?? 3001), "127.0.0.1");
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await bootstrap();
}
