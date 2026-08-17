/* A short tour of the three architectures.
 *
 * Every line below is chosen because the three backends answer it
 * differently. Open the assembly beside this file (Cmd-Alt-A), then change
 * the target in the status bar and watch the pane redraw.
 */
#include <stdio.h>

struct point { double x, y, z; };

/* AAPCS64 sends this in three vector registers, whatever its size, because it
 * is a homogeneous float aggregate. System V cuts it into eightbytes. The
 * Microsoft ABI takes a pointer, because 24 bytes is not 1, 2, 4 or 8. */
double total(struct point p)
{
    return p.x + p.y + p.z;
}

/* Integer wrap-around at a width narrower than the register: arm64 has to cut
 * the result back to int, x86-64 does it by writing the 32-bit register. */
int square(int n)
{
    return n * n;
}

int main(void)
{
    struct point p;
    p.x = 1.5; p.y = 2.25; p.z = 3.0;

    printf("total   = %.2f\n", total(p));
    printf("square  = %d\n", square(100000));
    return 0;
}
