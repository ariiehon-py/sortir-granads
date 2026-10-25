import { Container, getContainer } from "@cloudflare/containers";

export class SortirContainer extends Container {
  defaultPort = 3000;
  sleepAfter = "10m";

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = {
      PORT: "3000",
      GOOGLE_API_KEY: env.GOOGLE_API_KEY || "",
      GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID || "",
      GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET || "",
      GOOGLE_REDIRECT_URI: env.GOOGLE_REDIRECT_URI || "",
      ADMIN_EMAILS: env.ADMIN_EMAILS || "",
      FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || "",
      FIREBASE_CLIENT_EMAIL: env.FIREBASE_CLIENT_EMAIL || "",
      FIREBASE_PRIVATE_KEY: env.FIREBASE_PRIVATE_KEY || "",
    };
  }
}

export default {
  async fetch(request, env) {
    return getContainer(env.SORTIR_CONTAINER).fetch(request);
  },
};
