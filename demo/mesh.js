// A textured depth surface rendered with an off-axis camera. No external
// libraries or vertex texture fetch support are required (WebGL 1).
class DepthMeshRenderer {
  constructor(gl) {
    this.gl = gl;
    this.tiles = [];
    this.depthSource = null;
    const vertexSource = `
      precision highp float;
      attribute vec3 a_surface;
      uniform vec2 u_pointer;
      uniform vec2 u_strength;
      varying highp vec3 v_photo;
      void main() {
        vec2 uv = a_surface.xy;
        // Near = 1, far = 2. Reciprocal depth keeps disparity linear.
        float z = 2.0 / (1.0 + a_surface.z);
        vec2 xy = (uv * 2.0 - 1.0) * z;
        // Translate the camera with an off-axis projection anchored at z=1.
        // The resulting shift matches the image mode's (1 - disparity).
        xy += 4.0 * u_pointer * u_strength * (z - 1.0);
        vec2 coverage = vec2(1.0) - 2.0 * min(u_strength, vec2(0.2));
        // Perspective projection: clipping planes at 0.5 and 3.0.
        gl_Position = vec4(xy / coverage, 1.4 * z - 1.2, z);
        // Project the photograph from the reference camera. This also avoids
        // texture distortion on sloping triangles at the neutral viewpoint.
        v_photo = vec3(uv * z, z);
      }
    `;
    const fragmentSource = `
      precision highp float;
      uniform highp sampler2D u_color;
      varying highp vec3 v_photo;
      void main() {
        gl_FragColor = vec4(texture2D(u_color, v_photo.xy / v_photo.z).rgb, 1.0);
      }
    `;
    const shaders = [];
    const program = gl.createProgram();
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
        const shader = gl.createShader(type);
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        gl.attachShader(program, shader);
      }
      gl.bindAttribLocation(program, 0, "a_surface");
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    } catch (error) {
      gl.deleteProgram(program);
      throw error;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
    this.program = program;
    this.pointerLocation = gl.getUniformLocation(program, "u_pointer");
    this.strengthLocation = gl.getUniformLocation(program, "u_strength");
    this.colorLocation = gl.getUniformLocation(program, "u_color");
  }

  clearGeometry() {
    for (const tile of this.tiles) {
      this.gl.deleteBuffer(tile.vertices);
      this.gl.deleteBuffer(tile.indices);
    }
    this.tiles = [];
    this.depthSource = null;
  }

  setDepth(image) {
    this.clearGeometry();
    const gl = this.gl;
    const { width, height } = image;
    const pixels = image.getContext("2d").getImageData(0, 0, width, height).data;
    // Roughly one vertex per two source pixels, capped for large photographs.
    const spacing = Math.max(2, Math.max(width, height) / 768);
    const columns = Math.max(1, Math.ceil(width / spacing));
    const rows = Math.max(1, Math.ceil(height / spacing));
    const sample = (u, v) => {
      const x = Math.max(0, Math.min(width - 1, u * width - 0.5));
      const y = Math.max(0, Math.min(height - 1, v * height - 0.5));
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const x1 = Math.min(x0 + 1, width - 1), y1 = Math.min(y0 + 1, height - 1);
      const fx = x - x0, fy = y - y0;
      const top = pixels[(y0 * width + x0) * 4] * (1 - fx) + pixels[(y0 * width + x1) * 4] * fx;
      const bottom = pixels[(y1 * width + x0) * 4] * (1 - fx) + pixels[(y1 * width + x1) * 4] * fx;
      return (top * (1 - fy) + bottom * fy) / 255;
    };
    // Tiles keep indices within Uint16 limits, including on WebGL 1 devices
    // without OES_element_index_uint. Shared border vertices sample identically.
    for (let row = 0; row < rows; row += 128) {
      for (let column = 0; column < columns; column += 128) {
        const tileColumns = Math.min(128, columns - column);
        const tileRows = Math.min(128, rows - row);
        const stride = tileColumns + 1;
        const vertices = new Float32Array(stride * (tileRows + 1) * 3);
        for (let y = 0; y <= tileRows; y += 1) {
          for (let x = 0; x <= tileColumns; x += 1) {
            const u = (column + x) / columns, v = (row + y) / rows;
            const index = (y * stride + x) * 3;
            vertices[index] = u;
            vertices[index + 1] = 1 - v;
            vertices[index + 2] = sample(u, v);
          }
        }
        const indices = new Uint16Array(tileColumns * tileRows * 6);
        let offset = 0;
        for (let y = 0; y < tileRows; y += 1) {
          for (let x = 0; x < tileColumns; x += 1) {
            const a = y * stride + x, b = a + 1, c = a + stride, d = c + 1;
            const diagonalAD = Math.abs(vertices[a * 3 + 2] - vertices[d * 3 + 2]);
            const diagonalBC = Math.abs(vertices[b * 3 + 2] - vertices[c * 3 + 2]);
            indices.set(diagonalAD < diagonalBC ? [a, c, d, a, d, b] : [a, c, b, b, c, d], offset);
            offset += 6;
          }
        }
        const tile = { vertices: gl.createBuffer(), indices: gl.createBuffer(), count: indices.length };
        this.tiles.push(tile);
        gl.bindBuffer(gl.ARRAY_BUFFER, tile.vertices);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, tile.indices);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      }
    }
    this.depthSource = image;
  }

  draw(texture, pointer, strength) {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.colorLocation, 0);
    gl.uniform2f(this.pointerLocation, pointer.x, pointer.y);
    gl.uniform2f(this.strengthLocation, strength.x, strength.y);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disableVertexAttribArray(1);
    gl.enableVertexAttribArray(0);
    for (const tile of this.tiles) {
      gl.bindBuffer(gl.ARRAY_BUFFER, tile.vertices);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, tile.indices);
      gl.drawElements(gl.TRIANGLES, tile.count, gl.UNSIGNED_SHORT, 0);
    }
  }
}
