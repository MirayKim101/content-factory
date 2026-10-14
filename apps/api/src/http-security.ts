import type { INestApplication } from "@nestjs/common";
import helmet from "helmet";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  browserWriteAllowed,
  browserWriteOrigins,
} from "./browser-write-policy.js";

export function configureHttpSecurity(app: INestApplication): void {
  const origins = browserWriteOrigins(process.env.API_BROWSER_ORIGINS);
  app.getHttpAdapter().getInstance().set("trust proxy", false);
  app.use(helmet());
  app.use(
    (request: IncomingMessage, response: ServerResponse, next: () => void) => {
      if (browserWriteAllowed(request, origins)) {
        next();
        return;
      }
      response.writeHead(403, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        // Never keep an unread, potentially unbounded denied body alive.
        Connection: "close",
      });
      response.end(
        JSON.stringify({
          error: {
            code: "BROWSER_WRITE_FORBIDDEN",
            message:
              "The request does not satisfy the private API write-origin policy.",
          },
        }),
      );
    },
  );
}
