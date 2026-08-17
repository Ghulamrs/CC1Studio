#include <stdio.h>

int main() {
    int x;
    printf("Table of what:");
    scanf("%d", &x);

    for(int i=1; i<=10; i++) {
        printf("%2d x %2d = %3d\n", i, x, i*x);
    }

    return 0;
}