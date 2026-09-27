import type { INestApplication } from "@nestjs/common";
import helmet from "helmet";

export function configureHttpSecurity(app: INestApplication): void {
  app.use(helmet());
}
