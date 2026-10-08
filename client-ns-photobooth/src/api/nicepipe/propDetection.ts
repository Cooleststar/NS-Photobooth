export type Point = [number, number]
/** box is tl, bl, br, tr */
export type PolyBox = [Point, Point, Point, Point]
/** name, bounding box */
export type PropDetection = [string, PolyBox]
