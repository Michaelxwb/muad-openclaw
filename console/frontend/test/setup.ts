HTMLCanvasElement.prototype.getContext = (() => ({
  fillRect: () => undefined,
  fillStyle: "",
})) as typeof HTMLCanvasElement.prototype.getContext;
