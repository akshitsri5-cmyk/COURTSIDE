// Court geometry in metres. Origin = centre of court, x along the length (-L/2..L/2),
// y along the width (-W/2..W/2), z up. Dimensions come from the active ruleset so
// FIBA (default) and other rulesets (e.g. NBA) can be swapped via configuration.

export const FIBA_COURT = Object.freeze({
  name: 'FIBA', length: 28, width: 15, lineWidth: 0.05,
  centreCircleR: 1.8, basketFromEndline: 1.575, rimHeight: 3.05, rimRadius: 0.225,
  threePointR: 6.75, threePointSideDist: 0.9, keyWidth: 4.9, ftLineFromEndline: 5.8,
  ftCircleR: 1.8, noChargeR: 1.25, backboardFromEndline: 1.2, ballRadius: 0.12,
});

export class CourtModel {
  constructor(dims = FIBA_COURT) {
    this.d = { ...dims };
    const d = this.d; this.hx = d.length / 2; this.hy = d.width / 2;
    this.basketX = this.hx - d.basketFromEndline;           // +/- basketX
    this.ftX = this.hx - d.ftLineFromEndline;               // +/- ftX
    this.tpY = this.hy - d.threePointSideDist;              // straight 3pt line y
    this.tpArcX = this.basketX - Math.sqrt(Math.max(0, d.threePointR ** 2 - this.tpY ** 2)); // where straight meets arc
    this.keyY = d.keyWidth / 2;
  }
  baskets() { return [[-this.basketX, 0], [this.basketX, 0]]; }
  rim3D(side) { return [side * this.basketX, 0, this.d.rimHeight]; }

  /** Named calibration keypoints (clickable on a real court). */
  keypoints() {
    const { hx, hy, ftX, keyY, tpY, tpArcX } = this, k = {};
    for (const s of [-1, 1]) {
      const S = s < 0 ? 'L' : 'R';
      k[`corner_${S}_top`] = [s * hx, -hy]; k[`corner_${S}_bottom`] = [s * hx, hy];
      k[`key_base_${S}_top`] = [s * hx, -keyY]; k[`key_base_${S}_bottom`] = [s * hx, keyY];
      k[`key_ft_${S}_top`] = [s * ftX, -keyY]; k[`key_ft_${S}_bottom`] = [s * ftX, keyY];
      k[`tp_base_${S}_top`] = [s * hx, -tpY]; k[`tp_base_${S}_bottom`] = [s * hx, tpY];
      k[`tp_arc_${S}_top`] = [s * tpArcX, -tpY]; k[`tp_arc_${S}_bottom`] = [s * tpArcX, tpY];
      k[`tp_top_${S}`] = [s * (this.basketX - this.d.threePointR), 0];
      k[`ft_circle_${S}`] = [s * (ftX - this.d.ftCircleR), 0];
    }
    k.centre_top = [0, -hy]; k.centre_bottom = [0, hy];
    k.centre_circle_top = [0, -this.d.centreCircleR]; k.centre_circle_bottom = [0, this.d.centreCircleR];
    return k;
  }

  /** Court markings as named polylines (arcs sampled). step = sampling distance in metres. */
  markings(step = 0.25) {
    const { hx, hy, ftX, keyY, tpY, tpArcX, basketX } = this, d = this.d, M = [];
    const seg = (a, b) => { const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step)); return Array.from({ length: n + 1 }, (_, i) => [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]); };
    const arc = (c, r, a0, a1) => { const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) * r / step)); return Array.from({ length: n + 1 }, (_, i) => { const a = a0 + (a1 - a0) * i / n; return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]; }); };
    M.push({ name: 'boundary', group: 'boundary', pts: [...seg([-hx, -hy], [hx, -hy]), ...seg([hx, -hy], [hx, hy]).slice(1), ...seg([hx, hy], [-hx, hy]).slice(1), ...seg([-hx, hy], [-hx, -hy]).slice(1)] });
    M.push({ name: 'centre_line', group: 'centre', pts: seg([0, -hy], [0, hy]) });
    M.push({ name: 'centre_circle', group: 'centre', pts: arc([0, 0], d.centreCircleR, 0, 2 * Math.PI) });
    for (const s of [-1, 1]) {
      const S = s < 0 ? 'L' : 'R';
      const a = Math.asin(tpY / d.threePointR);
      M.push({ name: `three_point_${S}`, group: 'three_point', pts: [...seg([s * hx, -tpY], [s * tpArcX, -tpY]), ...(s > 0 ? arc([basketX, 0], d.threePointR, Math.PI + a, Math.PI - a) : arc([-basketX, 0], d.threePointR, -a, a)).slice(1, -1), ...seg([s * tpArcX, tpY], [s * hx, tpY])] });
      M.push({ name: `key_${S}`, group: 'key', pts: [...seg([s * hx, -keyY], [s * ftX, -keyY]), ...seg([s * ftX, keyY], [s * hx, keyY])] });
      M.push({ name: `free_throw_${S}`, group: 'free_throw', pts: seg([s * ftX, -keyY], [s * ftX, keyY]) });
      M.push({ name: `ft_circle_${S}`, group: 'free_throw', pts: s > 0 ? arc([ftX, 0], d.ftCircleR, Math.PI / 2, 1.5 * Math.PI) : arc([-ftX, 0], d.ftCircleR, -Math.PI / 2, Math.PI / 2) });
    }
    return M;
  }

  /** Long straight lines used by the automatic line-detector hypotheses: {axis:'x'|'y', value, extent:[a,b]}. */
  straightLines() {
    const { hx, hy, ftX, keyY, tpY, tpArcX } = this;
    return [
      { axis: 'x', value: -hx, extent: [-hy, hy], name: 'endline_L' }, { axis: 'x', value: hx, extent: [-hy, hy], name: 'endline_R' },
      { axis: 'x', value: 0, extent: [-hy, hy], name: 'centre_line' },
      { axis: 'x', value: -ftX, extent: [-keyY, keyY], name: 'free_throw_L' }, { axis: 'x', value: ftX, extent: [-keyY, keyY], name: 'free_throw_R' },
      { axis: 'y', value: -hy, extent: [-hx, hx], name: 'sideline_top' }, { axis: 'y', value: hy, extent: [-hx, hx], name: 'sideline_bottom' },
      { axis: 'y', value: -keyY, extent: [ftX, hx], name: 'key_top', both: true }, { axis: 'y', value: keyY, extent: [ftX, hx], name: 'key_bottom', both: true },
      { axis: 'y', value: -tpY, extent: [tpArcX, hx], name: 'tp_top', both: true }, { axis: 'y', value: tpY, extent: [tpArcX, hx], name: 'tp_bottom', both: true },
    ];
  }

  /**
   * Boundary test. In FIBA the boundary line itself is OUT. Returns signed distance (m) from the
   * inner edge of the boundary line: positive = inside playing court, <= 0 = on/over the line.
   */
  insideMargin([x, y]) {
    const lw = this.d.lineWidth; return Math.min(this.hx - lw - Math.abs(x), this.hy - lw - Math.abs(y));
  }
  isOut(p) { return this.insideMargin(p) <= 0; }

  /** Nearest basket side (-1 left, +1 right). */
  sideOf([x]) { return x < 0 ? -1 : 1; }

  /**
   * Signed distance (m) from the OUTER edge of the three-point line for the given attacking basket.
   * > 0 means behind the line (3PT area), <= 0 means on the line or inside (2PT). The line belongs to the 2PT area.
   */
  threePointMargin([x, y], side = this.sideOf([x])) {
    // FIBA measures 6.75 m and 0.90 m to the OUTER edge of the line; the line itself is 2PT territory.
    if (side * x >= this.tpArcX) return Math.abs(y) - this.tpY;
    return Math.hypot(x - side * this.basketX, y) - this.d.threePointR;
  }
  isThreePoint(p, side) { return this.threePointMargin(p, side) > 0; }

  inRestrictedArea([x, y], side = this.sideOf([x])) { return Math.hypot(x - side * this.basketX, y) <= this.d.noChargeR; }
  inKey([x, y], side = this.sideOf([x])) { return side * x >= this.ftX && side * x <= this.hx && Math.abs(y) <= this.keyY; }
  distToBasket([x, y], side = this.sideOf([x])) { return Math.hypot(x - side * this.basketX, y); }
}
