import { Controller, Get } from "@nestjs/common";

@Controller("api/v1")
export class AppController {
  @Get("health")
  health(): { status: "ok" } {
    return { status: "ok" };
  }
}
