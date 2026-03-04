import type * as React from "react";

interface ButtonProps {
	children: React.ReactNode;
	onClick?: () => void;
}

export const Button = (props: ButtonProps) => {
	return (
		<button type="button" className="bg-amber-500 p-2 rounded-lg" onClick={props.onClick}>{props.children}</button>
	);
};
