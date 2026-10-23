declare module 'caffeinate' {
    interface CaffeinateOptions {
        pid?: number;
        timeout?: number;
        /** The adapter emits boolean keys verbatim; include the dash. AC only. */
        '-s'?: boolean;
    }

    function caffeinate(options?: CaffeinateOptions): Promise<number>;

    export default caffeinate;
}
