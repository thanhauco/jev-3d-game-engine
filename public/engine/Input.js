/** Keyboard + pointer-lock mouse input, sampled per frame. */
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.down = new Set();
    this.pressed = new Set(); // edges this frame
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.buttons = new Set();
    this.clicked = new Set();

    addEventListener("keydown", (e) => {
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    addEventListener("keyup", (e) => this.down.delete(e.code));
    addEventListener("blur", () => this.down.clear());

    canvas.addEventListener("mousedown", (e) => {
      if (!this.locked) canvas.requestPointerLock?.();
      this.buttons.add(e.button);
      this.clicked.add(e.button);
    });
    addEventListener("mouseup", (e) => this.buttons.delete(e.button));
    addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
  }

  get locked() {
    return document.pointerLockElement === this.canvas;
  }

  isDown(code) {
    return this.down.has(code);
  }

  wasPressed(code) {
    return this.pressed.has(code);
  }

  wasClicked(button = 0) {
    return this.clicked.has(button);
  }

  /** Mouse deltas are consumed by whoever reads them first each frame. */
  consumeMouse() {
    const d = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = this.mouseDY = 0;
    return d;
  }

  endFrame() {
    this.pressed.clear();
    this.clicked.clear();
  }
}
