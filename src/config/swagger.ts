import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { Express } from "express";
import swaggerUi from "swagger-ui-express";
import { z } from "zod";

// Create global OpenAPI registry
export const registry = new OpenAPIRegistry();

// Register Bearer Auth Security Scheme
registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
  description: "Enter JWT Bearer token in the format: Bearer <token>",
});

// Register the global Health Check endpoint
registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health Check",
  description: "Check the status of the server and database connection",
  responses: {
    200: {
      description: "Server is healthy",
      content: {
        "application/json": {
          schema: z.object({
            status: z.string().openapi({ example: "OK" }),
            timestamp: z.string().openapi({ example: "2026-06-25T00:00:00.000Z" }),
          }),
        },
      },
    },
  },
});

export function setupSwagger(app: Express) {
  // Generate the OpenAPI document dynamically
  const getOpenApiDocument = () => {
    const generator = new OpenApiGeneratorV3(registry.definitions);
    return generator.generateDocument({
      openapi: "3.0.0",
      info: {
        title: "LabourBaba API Documentation",
        version: "1.0.0",
        description: "API documentation for the LabourBaba backend service, built with Express, Zod, and Swagger UI.",
      },
      servers: [
        {
          url: "http://localhost:5000",
          description: "Local development server",
        },
      ],
    });
  };

  // Serve raw JSON OpenAPI document
  app.get("/api-spec.json", (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.send(getOpenApiDocument());
  });

  // Serve Swagger UI
  app.use("/api-docs", swaggerUi.serve, (req: any, res: any, next: any) => {
    const doc = getOpenApiDocument();
    swaggerUi.setup(doc)(req, res, next);
  });

  console.log("Swagger UI is available at http://localhost:5000/api-docs");
}
