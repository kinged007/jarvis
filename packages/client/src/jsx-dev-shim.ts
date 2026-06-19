// Shim: React 19 + Vite SWC plugin generates jsxDEV calls but
// Vite pre-bundles the production jsx-dev-runtime where jsxDEV is void 0.
// Redirect to the regular jsx-runtime and alias jsxDEV → jsx.
export { jsx as jsxDEV, jsxs, Fragment } from "react/jsx-runtime";
