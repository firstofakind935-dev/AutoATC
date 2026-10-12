"""
Decides which minimap fixes to believe. The minimap is matched on coastline alone, so a look-alike shore can fool it
(on the apron there is almost no coastline at all and it landed 20 nm away several times in a row). Rules, the same as
the companion app's:
  - a fix that agrees with where we believe we are is taken;
  - a parked aircraft cannot jump (more than ~0.25 nm from the last position is refused);
  - a bigger jump is only believed after CONFIRMATIONS agreeing fixes in a row AND a strong match - and a parked
    aircraft needs the same wrong-looking answer to hold for PARKED_HOLD_SECONDS with an even stronger match (a static
    scene repeats the same wrong match every frame, so counting frames alone proves nothing);
  - with no position yet (no stand entered), the first fix must be a strong match.
A stand entry (anchor) sets the position directly.
"""

import math

CONFIRMATIONS = 3
TRUST_SCORE = 0.75
PARKED_KT = 5.0
PARKED_TRUST_SCORE = 0.85
PARKED_HOLD_SECONDS = 60.0
SPEED_WINDOW_S = 10.0
COAST_SECONDS = 30.0   # with no fix (open sea, a small island on final), keep moving along the track this long
MOVING_KT = 30.0       # below this there is no track worth coasting along
SPEED_CHANGE_KT = 60.0  # how far off the straight-line track an aircraft can get per hour of gap (turns, speed changes)


class PositionFilter:
    def __init__(self, trust_score=TRUST_SCORE, confirmations=CONFIRMATIONS):
        self.trust_score = trust_score
        self.confirmations = confirmations
        self.pos = None  # (x_nm, y_nm) in the radar frame
        self.t = None
        self.speed_kt = None
        self._pending = None  # [(x, y), count]
        self._track = []  # recent accepted fixes [(t, x, y)], for the ground speed
        self.velocity = None  # (vx, vy) in nm per hour, from the same window

    @property
    def has_position(self):
        return self.pos is not None

    def anchor(self, x_nm, y_nm, now):
        """A known position (the stand): trusted outright, and we are parked."""
        self.pos, self.t, self.speed_kt, self._pending = (x_nm, y_nm), now, 0.0, None
        self._track = [(now, x_nm, y_nm)]
        self.velocity = (0.0, 0.0)

    def _take(self, x, y, now):
        # Ground speed over the last few seconds of accepted fixes. (It used to be measured only between two fixes
        # 2 s or more apart - with a fix every second that never happened, so after a stand entry the aircraft
        # stayed "parked" for the whole flight and every gap in the fixes froze it.)
        self._track = [p for p in self._track if now - p[0] <= SPEED_WINDOW_S] + [(now, x, y)]
        t0, x0, y0 = self._track[0]
        if now - t0 >= 3.0:
            dt_h = (now - t0) / 3600.0
            self.velocity = ((x - x0) / dt_h, (y - y0) / dt_h)
            self.speed_kt = math.hypot(*self.velocity)
        self.pos, self.t, self._pending = (x, y), now, None

    def _moving(self):
        return self.velocity is not None and self.speed_kt is not None and self.speed_kt >= MOVING_KT

    def position_at(self, now):
        """
        Where we believe the aircraft is now: the last fix, carried along the track for up to COAST_SECONDS while
        no fix comes in (so the radar doesn't freeze over open sea or on final), then held.
        """
        if self.pos is None:
            return None
        if not self._moving():
            return self.pos
        dt_h = min(max(0.0, now - self.t), COAST_SECONDS) / 3600.0
        return (self.pos[0] + self.velocity[0] * dt_h, self.pos[1] + self.velocity[1] * dt_h)

    def _distance_from_path(self, x, y, now):
        """How far a fix is from anywhere we could have got to: the stretch between the last fix and where the last
        track would put us now (an aircraft that slowed down - say it landed - is somewhere along it)."""
        ax, ay = self.pos
        if not self._moving():
            return math.hypot(x - ax, y - ay)
        dt_h = max(0.0, now - self.t) / 3600.0
        bx, by = ax + self.velocity[0] * dt_h, ay + self.velocity[1] * dt_h
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        u = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / L2))
        return math.hypot(x - (ax + u * dx), y - (ay + u * dy))

    def accept(self, x_nm, y_nm, score, now):
        """-> (ok, reason). ok means: use this fix as the position."""
        if self.pos is None:
            if score >= self.trust_score:
                self._take(x_nm, y_nm, now)
                return True, "first fix"
            return False, f"first fix too weak ({score * 100:.0f}% match) - enter your stand to start from a known spot"
        moved = math.hypot(x_nm - self.pos[0], y_nm - self.pos[1])
        parked = self.speed_kt is not None and self.speed_kt < PARKED_KT
        since_h = max(0.0, now - self.t) / 3600.0
        if parked:
            off, allowed = moved, 0.25 + since_h * 40.0  # it can only have started taxiing since (~40 kt)
        elif self._moving():
            # Along the track we were flying, with room for turns and speed changes that grows with the gap. (It used
            # to be anywhere within 400 kt of the last fix - after a minute without fixes on final, ~7 nm, so the
            # first match after landing was believed even when it was a look-alike far away.)
            off, allowed = self._distance_from_path(x_nm, y_nm, now), 0.4 + since_h * SPEED_CHANGE_KT
        else:
            off, allowed = moved, 0.4 + since_h * 150.0  # slow or unknown: taxiing, or just started
        if off <= allowed:
            self._take(x_nm, y_nm, now)
            return True, "agrees"
        same = self._pending is not None and math.hypot(x_nm - self._pending[0][0], y_nm - self._pending[0][1]) < 0.3
        self._pending = [(x_nm, y_nm), (self._pending[1] + 1) if same else 1, self._pending[2] if same else now]
        count, first = self._pending[1], self._pending[2]
        need_score = PARKED_TRUST_SCORE if parked else self.trust_score
        held = (now - first) >= PARKED_HOLD_SECONDS if parked else True
        if count >= self.confirmations and score >= need_score and held:
            self._take(x_nm, y_nm, now)
            return True, "jump confirmed"
        return False, (f"ignored: {moved:.1f} nm from where you were, {score * 100:.0f}% match, "
                       f"{count}/{self.confirmations} agreeing" + (", parked" if parked else ""))
