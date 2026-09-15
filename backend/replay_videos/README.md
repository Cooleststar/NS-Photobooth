# Test videos

Recorded camera footage for replaying through the booth instead of a live
camera: the same people and movements every run, so a fix can be checked
against exactly the footage that showed the problem.

## Getting the footage

**Videos are not in git.** Ask a teammate for the testing footage and put it
in this folder. Everything here except this README is gitignored.

That is deliberate: the footage shows real people's faces, and this repository
is public. Anything pushed to it can be copied by anyone, and removing it later
does not take those copies back. Never force-add a video here
(`git add -f`), and don't move footage to another folder to commit it.

## Playing a video

1. Start the booth and press `S` for Settings.
2. Under **Testing**, click **Choose video…** and pick the file.
3. The feed switches to the video, looping at real speed. Every animation and
   detector runs on it exactly as on the live camera.
4. **Stop replay** returns to the camera that was selected before.

A video picked from this folder plays in place. One picked from anywhere else
is copied here first, which only happens once per file.

## Recording new footage

Record the camera's raw feed, not the booth screen: a recording of the screen
has animations drawn over the people, so replaying it tests the overlays rather
than detection. Any common format works (mp4, mkv, mov, avi, webm, ts, m4v).
