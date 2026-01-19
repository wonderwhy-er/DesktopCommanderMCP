declare module 'caffeinate' {
    interface CaffeinateOptions {
        pid?: number;
        timeout?: number;
        w?: number;
        t?: number;
    }

    function caffeinate(options?: CaffeinateOptions): Promise<number>;

    export default caffeinate;
}
