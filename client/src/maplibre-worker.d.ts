// Vite turns `?worker&url` into the URL of a separately built worker file (used to register MapLibre's tile worker).
declare module "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url" {
  const url: string;
  export default url;
}
