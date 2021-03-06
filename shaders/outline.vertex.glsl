precision mediump float;

attribute vec2 a_pos;

uniform highp mat4 u_matrix;
uniform vec2 u_world;

varying vec2 v_pos;

void main() {
    gl_Position = u_matrix * vec4(a_pos, 0, 1);
    v_pos = (gl_Position.xy/gl_Position.w + 1.0) / 2.0 * u_world;
}
