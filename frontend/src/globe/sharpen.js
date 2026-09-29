/* Baseline unsharp-mask sharpening — always-on readability pass.
   Shader adapted from bilawalsidhu/gods-eye-view (MIT, © 2026 Bilawal Sidhu —
   see THIRD-PARTY-NOTICES.md): src/ui/visualPresets.js SHARPEN_SHADER, used
   verbatim. This manager is ours.

   Unlike the sensor looks (which crossfade between each other via the
   sensors/index.js pipeline), sharpen is a *baseline* pass: it sits under
   everything at a restrained amount and stays on regardless of which sensor
   look is active. Esri World Imagery ships soft; a light unsharp mask makes
   it noticeably more readable without looking filtered.
*/
import * as Cesium from 'cesium';

const SHARPEN_SHADER = /* glsl */ `
  uniform sampler2D colorTexture;
  uniform vec2 colorTextureDimensions;
  uniform float amount;
  in vec2 v_textureCoordinates;

  void main() {
    vec2 uv = v_textureCoordinates;
    vec2 texel = 1.0 / colorTextureDimensions;
    vec4 center = texture(colorTexture, uv);
    vec4 blur = (
      texture(colorTexture, uv + vec2(-texel.x, -texel.y)) +
      texture(colorTexture, uv + vec2( 0.0,     -texel.y)) +
      texture(colorTexture, uv + vec2( texel.x, -texel.y)) +
      texture(colorTexture, uv + vec2(-texel.x,  0.0))     +
      center +
      texture(colorTexture, uv + vec2( texel.x,  0.0))     +
      texture(colorTexture, uv + vec2(-texel.x,  texel.y)) +
      texture(colorTexture, uv + vec2( 0.0,      texel.y)) +
      texture(colorTexture, uv + vec2( texel.x,  texel.y))
    ) / 9.0;
    vec4 sharpened = center + (center - blur) * amount;
    out_FragColor = vec4(clamp(sharpened.rgb, 0.0, 1.0), center.a);
  }
`;

/** Restrained default: crisp without halos. Tune once on desktop + mobile. */
export const SHARPEN_DEFAULT_AMOUNT = 0.28;

let stage = null;

/**
 * Add the baseline sharpen stage to the viewer. Call once at boot, after
 * initSensorLooks(). Idempotent.
 * @param {object} viewer Cesium viewer
 * @param {number} [amount] override for the default restrained amount
 */
export function initSharpen(viewer, amount = SHARPEN_DEFAULT_AMOUNT) {
  if (stage || !viewer) return stage;
  stage = new Cesium.PostProcessStage({
    name: 'baseline-sharpen',
    fragmentShader: SHARPEN_SHADER,
    uniforms: { amount },
  });
  stage.enabled = amount > 0.001;
  viewer.scene.postProcessStages.add(stage);
  return stage;
}

/** Adjust the sharpen amount live (0 disables the stage). */
export function setSharpenAmount(amount) {
  if (!stage) return;
  const v = Math.max(0, Math.min(1, Number(amount) || 0));
  stage.uniforms.amount = v;
  stage.enabled = v > 0.001;
}

/** Current sharpen amount (0 when uninitialized). */
export function getSharpenAmount() {
  return stage ? stage.uniforms.amount : 0;
}
