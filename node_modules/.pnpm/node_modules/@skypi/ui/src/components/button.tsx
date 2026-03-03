import * as React from "react"

interface ButtonProps {
    children: React.ReactNode
}

export const Button = (props: ButtonProps) => {
    return <button className="bg-amber-500 p-2 rounded-lg">{props.children}</button>
}