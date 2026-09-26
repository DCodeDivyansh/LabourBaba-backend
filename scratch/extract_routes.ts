process.env.NODE_ENV = "test";
import { app } from "../src/server";

interface RouteEntry {
  method: string;
  path: string;
  middlewares: string[];
}

const routes: RouteEntry[] = [];

function printStack(stack: any[], prefix = "") {
  if (!stack) return;
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).map(m => m.toUpperCase());
      const routePath = prefix + (layer.route.path === "/" ? "" : layer.route.path);
      const middlewares = layer.route.stack.map((s: any) => s.name || "anonymous");
      for (const method of methods) {
        routes.push({
          method,
          path: routePath || "/",
          middlewares
        });
      }
    } else if ((layer.name === "router" || layer.name === "bound dispatch") && layer.handle && layer.handle.stack) {
      let routerPrefix = "";
      if (layer.regexp) {
        let pattern = layer.regexp.source || "";
        pattern = pattern
          .replace("^\\/", "/")
          .replace("\\/?(?=\\/|$)", "")
          .replace("(?=\\/|$)", "")
          .replace(/\\\//g, "/")
          .replace(/\^/g, "")
          .replace(/\$/g, "")
          .replace(/\/?\?$/g, "");
        if (pattern === "\\/?") pattern = "";
        routerPrefix = pattern;
      }
      printStack(layer.handle.stack, prefix + routerPrefix);
    }
  }
}

const router = (app as any).router || (app as any)._router;
printStack(router.stack);

console.log(`Total registered routes: ${routes.length}`);
routes.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
for (const r of routes) {
  console.log(`${r.method.padEnd(7)} ${r.path.padEnd(55)} [${r.middlewares.join(", ")}]`);
}
