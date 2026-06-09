// https://github.com/wouterbulten/kalmanjs/blob/master/src/kalman.js
// see https://www.wouterbulten.nl/blog/tech/lightweight-javascript-library-for-noise-filtering/
// TODO: contribute these to @types/kalmanjs
declare module 'kalmanjs' {
  import KalmanFilter from 'kalmanjs'
  export interface KalmanFilterOpts {
    /** Process noise. Default 1. */
    R?: number
    /** Measurement noise. Default 1. */
    Q?: number
    /** State vector. Default 1. */
    A?: number
    /** Control vector. Default 0. */
    B?: number
    /** Measurement vector. Default 1. */
    C?: number
  }
  declare class KalmanFilter {
    constructor({ R = 1, Q = 1, A = 1, B = 0, C = 1 }: KalmanFilterOpts)
    /**
     * Filter a new value
     * @param z Measurement
     * @param u Control
     */
    filter(z: number, u = 0): number
    /**
     * Predict next value
     * @param u Control
     */
    predict(u = 0): number
    /**
     * Return uncertainty of filter
     */
    uncertainty(): number
    /**
     * Return the last filtered measurement
     */
    lastMeasurement(): number
    /**
     * Set measurement noise Q
     * @param noise noise
     */
    setMeasurementNoise(noise: number): void
    /**
     * Set the process noise R
     * @param noise noise
     */
    setProcessNoise(noise: number): void
  }
  export default KalmanFilter
}
