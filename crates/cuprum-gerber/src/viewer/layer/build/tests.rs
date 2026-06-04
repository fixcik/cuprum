mod circular_plotting_tests {
    use std::convert::TryFrom;
    use std::f64::consts::{FRAC_PI_2, PI};

    use gerber_types::{
        Aperture, ApertureDefinition, Circle, Command, CoordinateFormat, CoordinateMode,
        CoordinateNumber, CoordinateOffset, Coordinates, DCode, ExtendedCode, GCode,
        InterpolationMode, Operation, Unit, ZeroOmission,
    };

    use crate::viewer::layer::primitive::ArcGerberPrimitive;
    use crate::viewer::layer::{GerberLayer, GerberPrimitive};
    use crate::viewer::testing::dump_gerber_source;
    use crate::viewer::types::Exposure;

    #[test]
    fn test_rounded_rectangle_outline() {
        // Given
        env_logger::init();

        // and
        let corner_radius: f64 = 5.0; // mm
        let line_width: f64 = 0.1; // mm

        let format = CoordinateFormat::new(ZeroOmission::Leading, CoordinateMode::Absolute, 3, 5);

        // Set unit to millimeters
        let mut commands: Vec<Command> =
            vec![Command::ExtendedCode(ExtendedCode::Unit(Unit::Millimeters))];

        // Define circle aperture for outline
        commands.push(Command::ExtendedCode(ExtendedCode::ApertureDefinition(
            ApertureDefinition::new(12, Aperture::Circle(Circle::new(line_width))),
        )));

        // Format codes
        commands.push(Command::ExtendedCode(ExtendedCode::CoordinateFormat(
            format,
        )));
        commands.push(GCode::InterpolationMode(InterpolationMode::Linear).into());

        // Start at top-left corner
        commands.push(
            DCode::Operation(Operation::Move(Some(Coordinates::new(
                CoordinateNumber::try_from(5.0).unwrap(),
                CoordinateNumber::try_from(15.0).unwrap(),
                format,
            ))))
            .into(),
        );

        // Select aperture
        commands.push(DCode::SelectAperture(12).into());

        // Draw top-left corner arc (counterclockwise)
        commands.push(GCode::InterpolationMode(InterpolationMode::CounterclockwiseCircular).into());
        commands.push(
            DCode::Operation(Operation::Interpolate(
                Some(Coordinates::new(
                    CoordinateNumber::try_from(0.0).unwrap(),
                    CoordinateNumber::try_from(10.0).unwrap(),
                    format,
                )),
                Some(CoordinateOffset::new(
                    CoordinateNumber::try_from(0.0).unwrap(),
                    CoordinateNumber::try_from(-5.0).unwrap(),
                    format,
                )),
            ))
            .into(),
        );

        // Linear interpolation for left side
        commands.push(GCode::InterpolationMode(InterpolationMode::Linear).into());
        commands.push(
            DCode::Operation(Operation::Interpolate(
                Some(Coordinates::new(
                    CoordinateNumber::try_from(0.0).unwrap(),
                    CoordinateNumber::try_from(5.0).unwrap(),
                    format,
                )),
                None,
            ))
            .into(),
        );

        // Bottom-left corner arc (counterclockwise)
        commands.push(GCode::InterpolationMode(InterpolationMode::CounterclockwiseCircular).into());
        commands.push(
            DCode::Operation(Operation::Interpolate(
                Some(Coordinates::new(
                    CoordinateNumber::try_from(5.0).unwrap(),
                    CoordinateNumber::try_from(0.0).unwrap(),
                    format,
                )),
                Some(CoordinateOffset::new(
                    CoordinateNumber::try_from(5.0).unwrap(),
                    CoordinateNumber::try_from(0.0).unwrap(),
                    format,
                )),
            ))
            .into(),
        );

        // Linear interpolation for bottom side
        commands.push(GCode::InterpolationMode(InterpolationMode::Linear).into());
        commands.push(
            DCode::Operation(Operation::Interpolate(
                Some(Coordinates::new(
                    CoordinateNumber::try_from(15.0).unwrap(),
                    CoordinateNumber::try_from(0.0).unwrap(),
                    format,
                )),
                None,
            ))
            .into(),
        );

        // Bottom-right corner arc (counterclockwise)
        commands.push(GCode::InterpolationMode(InterpolationMode::CounterclockwiseCircular).into());
        commands.push(
            DCode::Operation(Operation::Interpolate(
                Some(Coordinates::new(
                    CoordinateNumber::try_from(20.0).unwrap(),
                    CoordinateNumber::try_from(5.0).unwrap(),
                    format,
                )),
                Some(CoordinateOffset::new(
                    CoordinateNumber::try_from(0.0).unwrap(),
                    CoordinateNumber::try_from(5.0).unwrap(),
                    format,
                )),
            ))
            .into(),
        );

        // Linear interpolation for right side
        commands.push(GCode::InterpolationMode(InterpolationMode::Linear).into());
        commands.push(
            DCode::Operation(Operation::Interpolate(
                Some(Coordinates::new(
                    CoordinateNumber::try_from(20.0).unwrap(),
                    CoordinateNumber::try_from(10.0).unwrap(),
                    format,
                )),
                None,
            ))
            .into(),
        );

        // Top-right corner arc (counterclockwise)
        commands.push(GCode::InterpolationMode(InterpolationMode::CounterclockwiseCircular).into());
        commands.push(
            DCode::Operation(Operation::Interpolate(
                Some(Coordinates::new(
                    CoordinateNumber::try_from(15.0).unwrap(),
                    CoordinateNumber::try_from(15.0).unwrap(),
                    format,
                )),
                Some(CoordinateOffset::new(
                    CoordinateNumber::try_from(-5.0).unwrap(),
                    CoordinateNumber::try_from(0.0).unwrap(),
                    format,
                )),
            ))
            .into(),
        );

        // Linear interpolation for top side (back to start)
        commands.push(GCode::InterpolationMode(InterpolationMode::Linear).into());
        commands.push(
            DCode::Operation(Operation::Interpolate(
                Some(Coordinates::new(
                    CoordinateNumber::try_from(5.0).unwrap(),
                    CoordinateNumber::try_from(15.0).unwrap(),
                    format,
                )),
                None,
            ))
            .into(),
        );

        // and
        dump_gerber_source(&commands);

        // When
        let gerber_layer = GerberLayer::new(commands);
        let primitives = gerber_layer.primitives();
        println!("primitives");
        primitives
            .iter()
            .for_each(|primitive| println!("{:?}", primitive));

        // Then
        // Verify primitives count - should have 4 lines and 4 arcs and 8 circles
        assert_eq!(primitives.len(), 16);

        // Verify that we have the required groups
        for (i, primitive) in primitives.iter().enumerate() {
            match i % 4 {
                0 => assert!(
                    matches!(primitive, GerberPrimitive::Circle { .. }),
                    "Expected Circle at index {}",
                    i
                ),
                1 => assert!(
                    matches!(primitive, GerberPrimitive::Arc { .. }),
                    "Expected Arc at index {}",
                    i
                ),
                2 => assert!(
                    matches!(primitive, GerberPrimitive::Circle { .. }),
                    "Expected Circle at index {}",
                    i
                ),
                3 => assert!(
                    matches!(primitive, GerberPrimitive::Line { .. }),
                    "Expected Line at index {}",
                    i
                ),
                _ => unreachable!(),
            }
        }

        // Define the expected positions for centers and radii first
        let expected_centers = [(5.0, 10.0), (5.0, 5.0), (15.0, 5.0), (15.0, 10.0)];

        // Collect all arcs for property testing
        let arcs: Vec<_> = primitives
            .iter()
            .cloned()
            .enumerate()
            .filter_map(|(i, p)| {
                if let GerberPrimitive::Arc(arc) = p {
                    Some((i, arc))
                } else {
                    None
                }
            })
            .collect();

        // Verify we have exactly 4 arcs
        assert_eq!(arcs.len(), 4, "Expected exactly 4 arcs");

        // Property 1: All sweep angles should be PI/2
        for (i, (arc_index, ArcGerberPrimitive { sweep_angle, .. })) in arcs.iter().enumerate() {
            assert!(
                (sweep_angle - FRAC_PI_2).abs() < f64::EPSILON,
                "Arc {} at index {} has sweep angle {} which is not PI/2 (expected {})",
                i,
                arc_index,
                sweep_angle,
                FRAC_PI_2
            );
        }

        // Property 2: All radii should be equal to corner_radius
        for (i, (arc_index, ArcGerberPrimitive { radius, .. })) in arcs.iter().enumerate() {
            assert_eq!(
                *radius, corner_radius,
                "Arc {} at index {} has radius {} which is not equal to corner_radius {}",
                i, arc_index, radius, corner_radius
            );
        }

        // Property 3: All line widths should be equal to line_width
        for (i, (arc_index, ArcGerberPrimitive { width, .. })) in arcs.iter().enumerate() {
            assert_eq!(
                *width, line_width,
                "Arc {} at index {} has width {} which is not equal to line_width {}",
                i, arc_index, width, line_width
            );
        }

        // Property 4: All arcs should have Add exposure
        for (i, (arc_index, ArcGerberPrimitive { exposure, .. })) in arcs.iter().enumerate() {
            assert!(
                matches!(*exposure, Exposure::Add),
                "Arc {} at index {} has exposure {:?} which is not Add",
                i,
                arc_index,
                exposure
            );
        }

        // Property 5: Centers should match expected positions
        for (center_index, (arc_index, ArcGerberPrimitive { center, .. })) in
            arcs.iter().enumerate()
        {
            let expected_center = expected_centers[center_index];
            let arc_center = (center.x, center.y);
            assert_eq!(
                arc_center, expected_center,
                "Arc {} at index {} has center {:?} which is not equal to expected {:?}",
                center_index, arc_index, arc_center, expected_center
            );
        }

        // Display start angles for each arc to document the pattern
        println!("Arc start angles (in radians):");
        for (i, (arc_index, ArcGerberPrimitive { start_angle, .. })) in arcs.iter().enumerate() {
            // Convert to degrees for more readable output
            let degrees = start_angle.to_degrees();
            println!(
                "Arc {}, index: {}, start_angle = {} rad ({}°)",
                i, arc_index, start_angle, degrees
            );
        }

        // Optionally, verify the specific pattern of start angles that was observed
        // This is kept separate as it's more of a documentation of the observed pattern
        // rather than an enforced property of the API
        let expected_start_angles = [FRAC_PI_2, PI, -FRAC_PI_2, 0.0];
        let angle_names = ["PI", "-PI/2", "0", "PI/2"]; // For better error messages

        for (idx, ((arc_idx, ArcGerberPrimitive { start_angle, .. }), angle_name)) in
            arcs.iter().zip(angle_names.iter()).enumerate()
        {
            assert!(
                (start_angle - expected_start_angles[idx]).abs() < f64::EPSILON,
                "Arc at index {} has start_angle {} which doesn't match expected {} ({})",
                arc_idx,
                start_angle,
                angle_name,
                expected_start_angles[idx]
            );
        }
    }
}
