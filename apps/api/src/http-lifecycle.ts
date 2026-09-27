import type { INestApplication } from "@nestjs/common";

export const API_SHUTDOWN_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

export function enableApiShutdownHooks(app: INestApplication): void {
  app.enableShutdownHooks(API_SHUTDOWN_SIGNALS);
}
