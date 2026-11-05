# 3D raytracer with spheres, checkerboard plane, and point lighting.
# All constants until arrays/structs are available.
# Each pixel outputs R, G, B on three lines, row separator: -1.0.

# ---- Math utilities ----
# 3D dot product (one per-level op via parentheses)
dot3 = lambda ax ay az bx by bz -> (ax*bx) + ((ay*by) + (az*bz))

abs = lambda x -> if x < 0.0 then -x else x

# Newton-Raphson sqrt, 8 iterations
sqrtN = lambda x guess n -> if n < 1 then guess else sqrtN(x, ((guess + (x / guess)) / 2.0), (n - 1))

sqrt = lambda x -> sqrtN(x, if x < 1.0 then 1.0 else x, 8)

# ---- Ray-sphere intersection ----
# Quadratic coeffs a,b,c for: a*t^2 + b*t + c = 0
rSphereA = lambda dx dy dz -> (dx*dx) + ((dy*dy) + (dz*dz))

rSphereB = lambda dx dy dz cx cy cz -> -2.0 * ((dx*cx) + ((dy*cy) + (dz*cz)))

rSphereC = lambda cx cy cz r -> ((cx*cx) + ((cy*cy) + (cz*cz))) - (r*r)

# Solve quadratic: t = (-b - sqrt(b^2 - 4ac)) / (2a)
rSphereTImpl = lambda a b c ->
  if ((b*b) - ((4.0*a)*c)) < 0.0 then
    -1.0
  else
    ((-b - sqrt((b*b) - ((4.0*a)*c))) / (2.0 * a))

rSphereT = lambda dx dy dz cx cy cz r ->
  rSphereTImpl(rSphereA(dx, dy, dz), rSphereB(dx, dy, dz, cx, cy, cz), rSphereC(cx, cy, cz, r))

# ---- Diffuse lighting (unnormalized, distance-attenuated) ----
simpleDiffuse = lambda nx ny nz lnx lny lnz ->
  if ((nx*lnx) + ((ny*lny) + (nz*lnz))) > 0.0 then
    ((nx*lnx) + ((ny*lny) + (nz*lnz))) / ((lnx*lnx) + ((lny*lny) + (lnz*lnz)))
  else
    0.0

# ---- Checkerboard cell parity ----
cellParity = lambda coord size ->
  if coord < 0.0 then
    cellParity(-coord, size)
  else if coord < size then
    0.0
  else if coord < (2.0 * size) then
    1.0
  else
    cellParity(coord - (2.0 * size), size)

checkerVal = lambda x y size ->
  if cellParity(x, size) < 0.5 then
    if cellParity(y, size) < 0.5 then 0.7 else 0.2
  else
    if cellParity(y, size) < 0.5 then 0.2 else 0.7

# ---- Camera position and direction ----
camX = 0.0
camY = 0.0
camZ = 0.0
camDirX = 0.1
camDirY = 0.0
camDirZ = -2.5

# ---- Image size ----
size = 200
step = 4.0 / float(size - 1)
substep = step / 4.0

# ---- Scene: Sphere 1 (warm orange) ----
s1cx = 0.0
s1cy = 0.0
s1cz = -5.0
s1r = 1.5
s1cr = 1.0
s1cg = 0.4
s1cb = 0.3

# ---- Scene: Sphere 2 (cool blue) ----
s2cx = 2.0
s2cy = 0.5
s2cz = -4.5
s2r = 1.0
s2cr = 0.3
s2cg = 0.5
s2cb = 1.0

# ---- Scene: Ground plane ----
planeZ = -7.0
checkSize = 2.0

# ---- Scene: Point light ----
lx = 2.4
ly = 1.0
lz = -3.0

ambient = 0.15
lightIntensity = 0.85

# ---- Sphere 1 color helpers ----
# Normal: (hit - center) / radius. Light dir: (light - hit)
s1Light = lambda dirX dirY dirZ t ->
  ambient + (lightIntensity *
    simpleDiffuse(
      (((t*dirX) - s1cx) / s1r), (((t*dirY) - s1cy) / s1r), (((t*dirZ) - s1cz) / s1r),
      (lx - (t*dirX)), (ly - (t*dirY)), (lz - (t*dirZ))))

s1Red = lambda dirX dirY dirZ t -> s1cr * s1Light(dirX, dirY, dirZ, t)
s1Green = lambda dirX dirY dirZ t -> s1cg * s1Light(dirX, dirY, dirZ, t)
s1Blue = lambda dirX dirY dirZ t -> s1cb * s1Light(dirX, dirY, dirZ, t)

# ---- Sphere 2 color helpers ----
s2Light = lambda dirX dirY dirZ t ->
  ambient + (lightIntensity *
    simpleDiffuse(
      (((t*dirX) - s2cx) / s2r), (((t*dirY) - s2cy) / s2r), (((t*dirZ) - s2cz) / s2r),
      (lx - (t*dirX)), (ly - (t*dirY)), (lz - (t*dirZ))))

s2Red = lambda dirX dirY dirZ t -> s2cr * s2Light(dirX, dirY, dirZ, t)
s2Green = lambda dirX dirY dirZ t -> s2cg * s2Light(dirX, dirY, dirZ, t)
s2Blue = lambda dirX dirY dirZ t -> s2cb * s2Light(dirX, dirY, dirZ, t)

# ---- Plane color (gray checkerboard) ----
planeGray = lambda dirX dirY dirZ -> checkerVal(((planeZ * dirX) / dirZ), ((planeZ * dirY) / dirZ), checkSize)

# ---- Per-channel sample functions ----
sampleR = lambda dx dy ->
  if rSphereT(camDirX + dx, camDirY + dy, camDirZ, s1cx - camX, s1cy - camY, s1cz - camZ, s1r) > 0.0 then
    s1Red(camDirX + dx, camDirY + dy, camDirZ, rSphereT(camDirX + dx, camDirY + dy, camDirZ, s1cx - camX, s1cy - camY, s1cz - camZ, s1r))
  else
    if rSphereT(camDirX + dx, camDirY + dy, camDirZ, s2cx - camX, s2cy - camY, s2cz - camZ, s2r) > 0.0 then
      s2Red(camDirX + dx, camDirY + dy, camDirZ, rSphereT(camDirX + dx, camDirY + dy, camDirZ, s2cx - camX, s2cy - camY, s2cz - camZ, s2r))
    else
      if camDirZ < 0.0 then
        planeGray(camDirX + dx, camDirY + dy, camDirZ)
      else
        0.0

sampleG = lambda dx dy ->
  if rSphereT(camDirX + dx, camDirY + dy, camDirZ, s1cx - camX, s1cy - camY, s1cz - camZ, s1r) > 0.0 then
    s1Green(camDirX + dx, camDirY + dy, camDirZ, rSphereT(camDirX + dx, camDirY + dy, camDirZ, s1cx - camX, s1cy - camY, s1cz - camZ, s1r))
  else
    if rSphereT(camDirX + dx, camDirY + dy, camDirZ, s2cx - camX, s2cy - camY, s2cz - camZ, s2r) > 0.0 then
      s2Green(camDirX + dx, camDirY + dy, camDirZ, rSphereT(camDirX + dx, camDirY + dy, camDirZ, s2cx - camX, s2cy - camY, s2cz - camZ, s2r))
    else
      if camDirZ < 0.0 then
        planeGray(camDirX + dx, camDirY + dy, camDirZ)
      else
        0.0

sampleB = lambda dx dy ->
  if rSphereT(camDirX + dx, camDirY + dy, camDirZ, s1cx - camX, s1cy - camY, s1cz - camZ, s1r) > 0.0 then
    s1Blue(camDirX + dx, camDirY + dy, camDirZ, rSphereT(camDirX + dx, camDirY + dy, camDirZ, s1cx - camX, s1cy - camY, s1cz - camZ, s1r))
  else
    if rSphereT(camDirX + dx, camDirY + dy, camDirZ, s2cx - camX, s2cy - camY, s2cz - camZ, s2r) > 0.0 then
      s2Blue(camDirX + dx, camDirY + dy, camDirZ, rSphereT(camDirX + dx, camDirY + dy, camDirZ, s2cx - camX, s2cy - camY, s2cz - camZ, s2r))
    else
      if camDirZ < 0.0 then
        planeGray(camDirX + dx, camDirY + dy, camDirZ)
      else
        0.0

# ---- 2x2 supersampling ----
rTotal = lambda cx cy -> (sampleR(cx - substep, cy - substep) + sampleR(cx + substep, cy - substep)) + (sampleR(cx - substep, cy + substep) + sampleR(cx + substep, cy + substep))
gTotal = lambda cx cy -> (sampleG(cx - substep, cy - substep) + sampleG(cx + substep, cy - substep)) + (sampleG(cx - substep, cy + substep) + sampleG(cx + substep, cy + substep))
bTotal = lambda cx cy -> (sampleB(cx - substep, cy - substep) + sampleB(cx + substep, cy - substep)) + (sampleB(cx - substep, cy + substep) + sampleB(cx + substep, cy + substep))

# ---- Scan over viewport ----
pixel = lambda px py ->
  if px < size then
    print(rTotal(((float(px)*step) - 2.0), ((float(py)*step) - 2.0)) / 4.0) +
    (print(gTotal(((float(px)*step) - 2.0), ((float(py)*step) - 2.0)) / 4.0) +
     (print(bTotal(((float(px)*step) - 2.0), ((float(py)*step) - 2.0)) / 4.0) +
      pixel(px + 1, py)))
  else
    print(-1.0) + 0.0

row = lambda py ->
  if py < size then
    pixel(0, py) + row(py + 1)
  else
    0.0

main = lambda -> row(0)