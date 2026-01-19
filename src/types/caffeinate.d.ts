declare module 'caffeinate' {
    interface CaffeinateOptions {
        pid?: number;
        timeout?: number;
    }

    function caffeinate(options?: CaffeinateOptions): Promise<number>;

    export default caffeinate;
}