import { registerHooks } from "node:module";

const missingMock = encodeURIComponent(
  'throw new Error("Provide explicit SDK mocks in local tests.");',
);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "sdk" || specifier === "sdk/db") {
      return {
        url: `data:text/javascript,${missingMock}#${encodeURIComponent(specifier)}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
